import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import forge from 'node-forge';
import { eq } from 'drizzle-orm';
import { WsaaClient, WsaaAlreadyAuthenticatedError } from '../../src/modules/arca/infrastructure/wsaa/wsaa-client.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { fiscalIdentities } from '../../src/infrastructure/database/schema/fiscal-identities.js';
import { wsaaAccessTickets } from '../../src/infrastructure/database/schema/wsaa-access-tickets.js';

const loginResponse = (token: string, expiresInMs: number) => {
  const ticket = `<?xml version="1.0" encoding="UTF-8"?><loginTicketResponse version="1.0"><header><generationTime>${new Date().toISOString()}</generationTime><expirationTime>${new Date(Date.now() + expiresInMs).toISOString()}</expirationTime></header><credentials><token>${token}</token><sign>firma-${token}</sign></credentials></loginTicketResponse>`;
  const escaped = ticket.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse><loginCmsReturn>${escaped}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`;
};

const alreadyAuthenticatedFault = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>ns1:coe.alreadyAuthenticated</faultcode><faultstring>El CEE ya posee un TA valido para el acceso al WSN solicitado</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`;

describe('WSAA: renovación de ticket de acceso', () => {
  let identityId: string;
  let privateKeyPem: string;
  let certificatePem: string;

  beforeAll(async () => {
    const db = getDatabase();
    const [tenant] = await db.insert(tenants).values({ name: 'WSAA Test', slug: `wsaa-test-${Date.now()}` }).returning();
    const [identity] = await db
      .insert(fiscalIdentities)
      .values({ tenantId: tenant!.id, cuit: '20301234567', businessName: 'WSAA Test S.A.' })
      .returning();
    identityId = identity!.id;

    const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 3600000);
    cert.validity.notAfter = new Date(Date.now() + 3600000);
    cert.setSubject([{ name: 'commonName', value: 'wsaa-test' }]);
    cert.setIssuer([{ name: 'commonName', value: 'wsaa-test' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    certificatePem = forge.pki.certificateToPem(cert);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getDatabase().delete(wsaaAccessTickets).where(eq(wsaaAccessTickets.fiscalIdentityId, identityId));
  });

  afterAll(async () => {
    await getDatabase().delete(fiscalIdentities).where(eq(fiscalIdentities.id, identityId));
    await closeDatabaseConnection();
  });

  it('peticiones concurrentes sin ticket hacen un único login en WSAA', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(loginResponse('nuevo', 12 * 3600000), { status: 200 }));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => WsaaClient.getTicket(identityId, privateKeyPem, certificatePem))
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.token))).toEqual(new Set(['nuevo']));
  });

  it('si WSAA informa un TA vigente, reutiliza el ticket en caché aunque esté por vencer', async () => {
    await getDatabase().insert(wsaaAccessTickets).values({
      fiscalIdentityId: identityId,
      service: 'wsfe',
      environment: 'homologation',
      token: 'por-vencer',
      sign: 'firma-por-vencer',
      generationTime: new Date(Date.now() - 11 * 3600000),
      expirationTime: new Date(Date.now() + 5 * 60000)
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(alreadyAuthenticatedFault, { status: 500 }));

    const ticket = await WsaaClient.getTicket(identityId, privateKeyPem, certificatePem);
    expect(ticket.token).toBe('por-vencer');
    expect(ticket.fromCache).toBe(true);
  });

  it('sin ticket en caché, el TA vigente en WSAA se informa con un error claro', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(alreadyAuthenticatedFault, { status: 500 }));

    await expect(WsaaClient.getTicket(identityId, privateKeyPem, certificatePem)).rejects.toBeInstanceOf(
      WsaaAlreadyAuthenticatedError
    );
  });
});
