import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import forge from 'node-forge';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../../src/app/server.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { apiKeys } from '../../src/infrastructure/database/schema/api-keys.js';
import { fiscalIdentities } from '../../src/infrastructure/database/schema/fiscal-identities.js';
import { fiscalCertificates } from '../../src/infrastructure/database/schema/fiscal-certificates.js';
import { pointsOfSale } from '../../src/infrastructure/database/schema/points-of-sale.js';
import { invoices } from '../../src/infrastructure/database/schema/invoices.js';
import { idempotencyKeys } from '../../src/infrastructure/database/schema/idempotency-keys.js';
import { generateApiKey } from '../../src/core/security/api-key.js';
import { EncryptionService } from '../../src/core/security/encryption.js';
import { WsaaClient } from '../../src/modules/arca/infrastructure/wsaa/wsaa-client.js';
import { Wsfev1Client } from '../../src/modules/arca/infrastructure/wsfev1/wsfev1-client.js';
import { InvoiceRepository } from '../../src/modules/invoices/infrastructure/invoice-repository.js';
import { InfrastructureError } from '../../src/core/errors/app-error.js';

const authorizedCae = (nro: number, cae = '74123456789012') => ({
  resultado: 'A' as const,
  cae,
  caeFchVto: '20261120',
  cbteDesde: nro,
  cbteHasta: nro,
  cbteFch: '20261103',
  observaciones: [],
  errores: [],
  eventos: [],
  xmlRequest: '<mock-request />',
  xmlResponse: '<mock-response />'
});

const notRegisteredInArca = {
  encontrado: false,
  observaciones: [],
  errores: [{ code: 602, message: 'No existen datos en nuestros registros para los parametros ingresados.' }]
};

describe('Conciliación de comprobantes interrumpidos y numeración fiscal', () => {
  let app: FastifyInstance;
  let tenantKey: string;
  let fiscalIdentityId: string;

  const emit = (extraHeaders: Record<string, string> = {}, extraPayload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { 'x-api-key': tenantKey, ...extraHeaders },
      payload: {
        fiscalIdentityId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        items: [{ description: 'Gaseosa 500ml', quantity: 1, unitPrice: 500 }],
        ...extraPayload
      }
    });

  const findInvoice = async (id: string) => {
    const [row] = await getDatabase().select().from(invoices).where(eq(invoices.id, id)).limit(1);
    return row!;
  };

  const mockTimeout = () =>
    vi.spyOn(Wsfev1Client, 'solicitarCae').mockRejectedValueOnce(
      new InfrastructureError('Timeout al conectar con WSFEv1 (25000ms)')
    );

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    const db = getDatabase();

    await db.delete(invoices);
    await db.delete(idempotencyKeys);
    await db.delete(pointsOfSale);
    await db.delete(fiscalCertificates);
    await db.delete(fiscalIdentities);
    await db.delete(apiKeys);
    await db.delete(tenants);

    const [tenant] = await db.insert(tenants).values({ name: 'Comercio Conciliación', slug: 'comercio-conciliacion' }).returning();
    const keyGen = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenant!.id,
      name: 'POS Caja 1',
      keyHash: keyGen.keyHash,
      prefix: keyGen.prefix,
      role: 'pos_client'
    });
    tenantKey = keyGen.rawKey;

    const [identity] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId: tenant!.id,
        cuit: '20301234567',
        businessName: 'Comercio Conciliación S.A.',
        environment: 'homologation',
        status: 'CONNECTED'
      })
      .returning();
    fiscalIdentityId = identity!.id;

    const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 3600000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
    cert.setSubject([{ name: 'commonName', value: 'computador1' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const enc = EncryptionService.encrypt(forge.pki.privateKeyToPem(keys.privateKey));

    await db.insert(fiscalCertificates).values({
      fiscalIdentityId,
      encryptedPrivateKey: enc.ciphertext,
      privateKeyIv: enc.iv,
      privateKeyAuthTag: enc.authTag,
      certificate: forge.pki.certificateToPem(cert),
      active: true
    });

    await db.insert(pointsOfSale).values({ fiscalIdentityId, number: 1, type: 'ELECTRONICA', active: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await closeDatabaseConnection();
  });

  const mockWsaa = () =>
    vi.spyOn(WsaaClient, 'getTicket').mockResolvedValue({
      token: 'mock-token',
      sign: 'mock-sign',
      expirationTime: new Date(Date.now() + 3600000),
      fromCache: true
    });

  it('1. Un comprobante no registrado en ARCA se cancela y libera su número para la próxima emisión', async () => {
    mockWsaa();
    vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(10);
    mockTimeout();

    const resTimeout = await emit();
    expect(resTimeout.statusCode).toBe(502);
    const pendingId = resTimeout.json().details.invoiceId as string;
    expect((await findInvoice(pendingId)).voucherNumber).toBe(11);

    vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue(notRegisteredInArca);
    const resReconcile = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${pendingId}/reconcile`,
      headers: { 'x-api-key': tenantKey }
    });
    expect(resReconcile.statusCode).toBe(200);
    expect(resReconcile.json().status).toBe('CANCELLED');
    expect(resReconcile.json().voucherNumber).toBeNull();

    // ARCA sigue informando 10 como último: el número 11 debe poder reutilizarse
    vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue(authorizedCae(11));
    const resRetry = await emit();
    expect(resRetry.statusCode).toBe(201);
    expect(resRetry.json().status).toBe('AUTHORIZED');
    expect(resRetry.json().voucherNumber).toBe(11);
  });

  it('2. La siguiente emisión de la secuencia concilia automáticamente un comprobante interrumpido', async () => {
    mockWsaa();
    vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(11);
    mockTimeout();

    const resTimeout = await emit();
    expect(resTimeout.statusCode).toBe(502);
    const pendingId = resTimeout.json().details.invoiceId as string;

    const consultSpy = vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue(notRegisteredInArca);
    vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue(authorizedCae(12));

    const resNext = await emit();
    expect(resNext.statusCode).toBe(201);
    expect(resNext.json().voucherNumber).toBe(12);
    expect(consultSpy).toHaveBeenCalledWith(expect.anything(), 1, 6, 12, expect.anything());

    const stale = await findInvoice(pendingId);
    expect(stale.status).toBe('CANCELLED');
    expect(stale.voucherNumber).toBeNull();
  });

  it('3. Reintentar con la misma clave de idempotencia devuelve la factura si ARCA la había autorizado', async () => {
    mockWsaa();
    vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(12);
    mockTimeout();

    const resTimeout = await emit({ 'x-idempotency-key': 'venta-0001' });
    expect(resTimeout.statusCode).toBe(502);
    const pendingId = resTimeout.json().details.invoiceId as string;

    vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue({
      encontrado: true,
      resultado: 'A',
      cae: '74555555555555',
      caeFchVto: '20261120',
      cbteDesde: 13,
      cbteHasta: 13,
      cbteFch: '20261101',
      observaciones: [],
      errores: []
    });
    // Vitest 5 reutiliza el espía existente: limpiar la llamada del intento interrumpido
    const solicitarSpy = vi.spyOn(Wsfev1Client, 'solicitarCae');
    solicitarSpy.mockClear();

    const resRetry = await emit({ 'x-idempotency-key': 'venta-0001' });
    expect(resRetry.statusCode).toBe(201);
    expect(resRetry.json().id).toBe(pendingId);
    expect(resRetry.json().status).toBe('AUTHORIZED');
    expect(resRetry.json().cae).toBe('74555555555555');
    expect(solicitarSpy).not.toHaveBeenCalled();

    // La fecha del QR debe ser la del comprobante en ARCA, no la de la conciliación
    const qrPayload = JSON.parse(
      Buffer.from(new URL(resRetry.json().qrData).searchParams.get('p')!, 'base64').toString('utf8')
    );
    expect(qrPayload.fecha).toBe('2026-11-01');
  });

  it('4. Si el CAE se obtiene pero no se puede guardar, queda PENDING_RECONCILIATION sin liberar la idempotencia', async () => {
    mockWsaa();
    vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(13);
    vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue(authorizedCae(14));
    vi.spyOn(InvoiceRepository.prototype, 'update').mockRejectedValueOnce(new Error('connection terminated'));

    const res = await emit({ 'x-idempotency-key': 'venta-0002' });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('PENDING_RECONCILIATION');

    const pending = await findInvoice(res.json().details.invoiceId);
    expect(pending.status).toBe('PENDING_RECONCILIATION');
    expect(pending.voucherNumber).toBe(14);

    const [idemp] = await getDatabase()
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, pending.tenantId), eq(idempotencyKeys.key, 'venta-0002')));
    expect(idemp?.status).toBe('PROCESSING');

    // Se resuelve con la conciliación (ARCA sí lo tiene)
    vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue({
      encontrado: true,
      resultado: 'A',
      cae: '74123456789012',
      caeFchVto: '20261120',
      cbteDesde: 14,
      cbteHasta: 14,
      cbteFch: '20261103',
      observaciones: [],
      errores: []
    });
    const resReconcile = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${pending.id}/reconcile`,
      headers: { 'x-api-key': tenantKey }
    });
    expect(resReconcile.json().status).toBe('AUTHORIZED');
  });

  it('5. Las fechas de servicio y vencimiento se envían a ARCA sin corrimiento de zona horaria', async () => {
    mockWsaa();
    vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(14);
    const solicitarSpy = vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue(authorizedCae(15));

    const res = await emit({}, {
      concept: 2,
      serviceDateFrom: '2026-11-01',
      serviceDateTo: '2026-11-30',
      paymentDueDate: '2026-12-10'
    });
    expect(res.statusCode).toBe(201);

    const detalle = solicitarSpy.mock.calls[0]![1].detalle;
    expect(detalle.fchServDesde).toBe('20261101');
    expect(detalle.fchServHasta).toBe('20261130');
    expect(detalle.fchVtoPago).toBe('20261210');

    const stored = await findInvoice(res.json().id);
    expect(stored.serviceDateFrom!.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })).toBe('1/11/2026');
  });

  it('6. Rechaza fechas con formato inválido', async () => {
    const res = await emit({}, {
      concept: 2,
      serviceDateFrom: '2026-02-31',
      serviceDateTo: '2026-11-30',
      paymentDueDate: '2026-12-10'
    });
    expect(res.statusCode).toBe(400);
  });

  it('7. Una respuesta ambigua de ARCA no cancela el comprobante', async () => {
    mockWsaa();
    vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(15);
    mockTimeout();

    const resTimeout = await emit();
    const pendingId = resTimeout.json().details.invoiceId as string;

    vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue({
      encontrado: false,
      observaciones: [],
      errores: [{ code: 600, message: 'ValidacionDeToken: No validaron las credenciales' }]
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${pendingId}/reconcile`,
      headers: { 'x-api-key': tenantKey }
    });
    expect(res.statusCode).toBe(502);

    const stillPending = await findInvoice(pendingId);
    expect(stillPending.status).toBe('PENDING_RECONCILIATION');
    expect(stillPending.voucherNumber).toBe(16);

    // Mientras siga sin resolverse, una nueva emisión no puede pisar el número: 409 en lugar de 500
    vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue(authorizedCae(16));
    const resNext = await emit();
    expect(resNext.statusCode).toBe(409);
    expect(resNext.json().details.invoiceId).toBe(pendingId);
  });

  it('8. Rechaza tipos de comprobante no soportados', async () => {
    const res = await emit({}, { voucherType: 201 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('no soportado');
  });

  it('9. No emite si la identidad fiscal no está CONNECTED', async () => {
    const db = getDatabase();
    await db.update(fiscalIdentities).set({ status: 'ACTION_REQUIRED' }).where(eq(fiscalIdentities.id, fiscalIdentityId));
    const solicitarSpy = vi.spyOn(Wsfev1Client, 'solicitarCae');

    const res = await emit();
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('no está habilitada para emitir');
    expect(solicitarSpy).not.toHaveBeenCalled();

    await db.update(fiscalIdentities).set({ status: 'CONNECTED' }).where(eq(fiscalIdentities.id, fiscalIdentityId));
  });

  it('10. Rechaza números de documento con caracteres que no sean dígitos (inyección XML)', async () => {
    const res = await emit({}, {
      customer: { docType: 96, docNumber: '123</fev:DocNro><fev:ImpTotal>1', name: 'Atacante' }
    });
    expect(res.statusCode).toBe(400);

    const resCf = await emit({}, { customer: { docType: 99, docNumber: '20301234567' } });
    expect(resCf.statusCode).toBe(400);
  });

  it('11. La base impide borrar identidades fiscales con comprobantes (conservación fiscal)', async () => {
    await expect(
      getDatabase().delete(fiscalIdentities).where(eq(fiscalIdentities.id, fiscalIdentityId))
    ).rejects.toThrow();
  });

  it('12. Rechaza un customerId que no pertenece al comercio', async () => {
    const res = await emit({}, { customerId: '00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('Cliente');
  });
});

