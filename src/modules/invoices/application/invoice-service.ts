import { eq, and, lte, asc, inArray } from 'drizzle-orm';
import { getDatabase } from '../../../infrastructure/database/connection.js';
import { idempotencyKeys } from '../../../infrastructure/database/schema/idempotency-keys.js';
import { invoices, type Invoice } from '../../../infrastructure/database/schema/invoices.js';
import { InvoiceRepository, type FullInvoice, type InvoiceListFilters } from '../infrastructure/invoice-repository.js';
import { FiscalIdentityRepository } from '../../fiscal-identities/infrastructure/fiscal-identity-repository.js';
import { CustomerRepository } from '../../customers/infrastructure/customer-repository.js';
import { ProductRepository } from '../../products/infrastructure/product-repository.js';
import { TaxCalculator, type InvoiceItemInput } from '../domain/tax-calculator.js';
import { FiscalQrGenerator } from '../domain/qr-generator.js';
import { WsaaClient } from '../../arca/infrastructure/wsaa/wsaa-client.js';
import { Wsfev1Client } from '../../arca/infrastructure/wsfev1/wsfev1-client.js';
import { EncryptionService } from '../../../core/security/encryption.js';
import { IdempotencyService, IdempotencyKeyMismatchError } from '../../../core/security/idempotency-service.js';
import { AuditService } from '../../audit/application/audit-service.js';
import { FiscalLock } from '../../../core/security/fiscal-lock.js';
import { AssociatedVoucherLock, type AssociatedVoucherRef } from '../../../core/security/voucher-lock.js';
import { cleanDocumentNumber, isValidCuit } from '../../../core/fiscal/cuit-validator.js';
import { isValidIsoDate, isoDateToAfip, isoDateToArgentinaNoon } from '../../../core/fiscal/fiscal-dates.js';
import type { FiscalIdentity } from '../../../infrastructure/database/schema/fiscal-identities.js';
import type { FiscalCertificate } from '../../../infrastructure/database/schema/fiscal-certificates.js';
import type { WsfeAuth } from '../../arca/infrastructure/wsfev1/wsfev1-client.js';
import {
  getVoucherLetter,
  isCreditNote,
  isDebitNote,
  isInvoice,
  requiresVatBreakdown,
  resolveItemVat,
  SUPPORTED_VOUCHER_TYPES
} from '../../../core/fiscal/tax-catalogs.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  FiscalError,
  InfrastructureError,
  ForbiddenError,
  TenantConcurrencyLimitError
} from '../../../core/errors/app-error.js';
import { LockTimeoutError, withAdvisoryLocks } from '../../../core/security/advisory-lock.js';
import { TenantInFlightLimiter } from '../../../core/security/tenant-in-flight.js';
import { SequenceNumberCache, sequenceOwner } from '../../../core/fiscal/sequence-cache.js';
import { loadConfig } from '../../../app/config.js';
import { logger } from '../../../app/logger.js';

export interface CustomerInlineInput {
  docType?: number | undefined; // 80=CUIT, 96=DNI, 99=Consumidor Final
  docNumber?: string | undefined;
  name?: string | undefined;
  taxCondition?: number | undefined; // 1=RI, 5=CF, 6=Monotributo, 4=Exento
  address?: string | undefined;
}

export interface AssociatedVoucherInput {
  voucherType: number;
  pointOfSale: number;
  voucherNumber: number;
  cuit?: string | undefined;
}

export interface EmitInvoiceInput {
  fiscalIdentityId: string;
  pointOfSaleNumber: number;
  voucherType: number; // 1=Factura A, 6=Factura B, 11=Factura C, etc.
  concept?: number | undefined; // 1=Productos, 2=Servicios, 3=Ambos
  serviceDateFrom?: string | undefined; // YYYY-MM-DD
  serviceDateTo?: string | undefined; // YYYY-MM-DD
  paymentDueDate?: string | undefined; // YYYY-MM-DD
  pricesIncludeVat?: boolean | undefined; // default true para POS
  customerId?: string | undefined;
  customer?: CustomerInlineInput | undefined;
  items: InvoiceItemInput[];
  associatedVouchers?: AssociatedVoucherInput[] | undefined;
  notes?: string | undefined;
  posSaleId?: string | undefined;
  idempotencyKey?: string | undefined;
}

/** Código de error que indica que el resultado en ARCA es incierto y el comprobante quedó pendiente de conciliar */
export const PENDING_RECONCILIATION_CODE = 'ARCA_PENDING_RECONCILIATION';

/** Código del 409 cuando el número que conciliamos en ARCA pertenece a un comprobante emitido por otro sistema */
export const FOREIGN_VOUCHER_CODE = 'ARCA_FOREIGN_VOUCHER';

/**
 * Ventana en la que ARCA pudo haber procesado NUESTRA solicitud, relativa al alta del registro PENDING
 * (que se crea justo antes de enviar FECAESolicitar). Un comprobante procesado fuera de ella es ajeno.
 */
const OWN_PROCESSING_WINDOW_BEFORE_MS = 60_000; // tolerancia de desfase de relojes con ARCA
// Peor caso de nuestra emisión tras crear el registro: FECAESolicitar (25 s) + FECompUltimoAutorizado (15 s)
// + reintento de FECAESolicitar (25 s), con margen
const OWN_PROCESSING_WINDOW_AFTER_MS = 3 * 60_000;

/** Estados con numeración asignada cuyo resultado en ARCA todavía no se conoce */
const UNRESOLVED_STATUSES = ['PENDING', 'PENDING_RECONCILIATION'];

/** Condiciones frente al IVA del receptor admitidas por WSFEv1 (FEParamGetCondicionIvaReceptor) */
const RECEPTOR_IVA_CONDITIONS = [1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16];
/** Condiciones admitidas para comprobantes clase A (RI y monotributistas) */
const RECEPTOR_IVA_CONDITIONS_A = [1, 6, 13, 16];

type ArcaEnvironment = 'homologation' | 'production';

export class InvoiceService {
  private invoiceRepo = new InvoiceRepository();
  private fiscalRepo = new FiscalIdentityRepository();
  private customerRepo = new CustomerRepository();
  private productRepo = new ProductRepository();

  /**
   * Crea un comprobante en estado borrador (DRAFT) sin consultar ARCA ni asignar numeración oficial
   */
  public async createDraft(
    tenantId: string,
    input: EmitInvoiceInput,
    userId?: string,
    userRole?: string
  ): Promise<FullInvoice> {
    const identity = await this.fiscalRepo.findById(tenantId, input.fiscalIdentityId);
    if (!identity) {
      throw new NotFoundError(`Identidad fiscal con ID "${input.fiscalIdentityId}" no encontrada`);
    }

    const ptos = await this.fiscalRepo.getPointsOfSale(identity.id);
    const ptoRecord = ptos.find((p) => p.number === input.pointOfSaleNumber && p.active);
    if (!ptoRecord) {
      throw new ValidationError(
        `El punto de venta ${input.pointOfSaleNumber} no está configurado o no se encuentra activo para la identidad fiscal ${identity.cuit}`
      );
    }

    this.validateFiscalRules(input);
    await this.assertCustomerBelongsToTenant(tenantId, input.customerId);
    await this.assertProductsBelongToTenant(tenantId, input.items);

    const voucherLetter = getVoucherLetter(input.voucherType);
    const pricesIncludeVat = input.pricesIncludeVat !== false;
    const calc = TaxCalculator.calculate(input.items, input.voucherType, pricesIncludeVat);

    await this.validateAssociatedVouchers(tenantId, identity, input, calc.totalAmount, userRole);

    const docType = input.customer?.docType ?? 99;
    const docNumber = this.normalizeDocNumber(input);
    const customerName = input.customer?.name ?? (docType === 99 ? 'Consumidor Final' : 'Cliente');

    const created = await this.invoiceRepo.createWithDetails(
      {
        tenantId,
        fiscalIdentityId: identity.id,
        pointOfSaleNumber: input.pointOfSaleNumber,
        voucherType: input.voucherType,
        voucherLetter,
        voucherNumber: null,
        concept: input.concept ?? 1,
        serviceDateFrom: input.serviceDateFrom ? isoDateToArgentinaNoon(input.serviceDateFrom) : undefined,
        serviceDateTo: input.serviceDateTo ? isoDateToArgentinaNoon(input.serviceDateTo) : undefined,
        paymentDueDate: input.paymentDueDate ? isoDateToArgentinaNoon(input.paymentDueDate) : undefined,
        status: 'DRAFT',
        totalAmount: calc.totalAmount.toFixed(2),
        netTaxedAmount: calc.netTaxedAmount.toFixed(2),
        netUntaxedAmount: calc.netUntaxedAmount.toFixed(2),
        exemptAmount: calc.exemptAmount.toFixed(2),
        vatAmount: calc.vatAmount.toFixed(2),
        specialTaxesAmount: calc.specialTaxesAmount.toFixed(2),
        customerId: input.customerId,
        customerDocType: docType,
        customerDocNumber: docNumber,
        customerName,
        customerTaxCondition: this.resolveReceptorIvaCondition(input),
        customerAddress: input.customer?.address,
        notes: input.notes,
        posSaleId: input.posSaleId,
        idempotencyKey: input.idempotencyKey
      },
      calc.items.map((it) => ({
        productId: it.productId,
        internalCode: it.internalCode,
        description: it.description,
        quantity: it.quantity.toFixed(4),
        unitPrice: it.unitPrice.toFixed(4),
        discount: it.discount.toFixed(4),
        vatRate: it.vatRate.toFixed(2),
        vatAfipCode: it.vatAfipCode,
        netSubtotal: it.netSubtotal.toFixed(2),
        vatSubtotal: it.vatSubtotal.toFixed(2),
        totalSubtotal: it.totalSubtotal.toFixed(2)
      })),
      calc.vatSubtotals.map((v) => ({
        vatAfipCode: v.vatAfipCode,
        vatRate: v.vatRate.toFixed(2),
        baseAmount: v.baseAmount.toFixed(2),
        vatAmount: v.vatAmount.toFixed(2)
      })),
      (input.associatedVouchers ?? []).map((a) => ({
        associatedVoucherType: a.voucherType,
        pointOfSale: a.pointOfSale,
        voucherNumber: a.voucherNumber,
        cuit: a.cuit
      }))
    );

    await AuditService.record({
      tenantId,
      userId,
      action: 'INVOICE_DRAFT_CREATED',
      entityType: 'invoice',
      entityId: created.id
    });

    return created;
  }

  /**
   * Emite y autoriza un comprobante en tiempo real ante ARCA WSFEv1 con asignación de CAE
   */
  public async emitInvoice(
    tenantId: string,
    input: EmitInvoiceInput,
    userId?: string,
    userRole?: string
  ): Promise<FullInvoice> {
    // M8: Si no se envió idempotencyKey pero sí posSaleId, deduplicar la FACTURA de esa venta con una clave implícita.
    // Sólo facturas (una NC/ND de devolución suele llevar el posSaleId de la venta original) y acotada a la API key,
    // identidad y PtoVta: varios POS del mismo comercio pueden generar posSaleId que se repiten entre sí.
    const posSaleId = input.posSaleId?.trim();
    if (!input.idempotencyKey && posSaleId && isInvoice(input.voucherType)) {
      input.idempotencyKey = `pos-sale:${userId ?? '-'}:${input.fiscalIdentityId}:${input.pointOfSaleNumber}:${posSaleId}`;
    }

    // 1. Control estricto de Idempotencia si el cliente envió idempotencyKey
    if (input.idempotencyKey) {
      const requestHash = IdempotencyService.hashPayload(this.fingerprint(input));
      const idempOptions = { requestHash };

      // Si existe un comprobante previo con esta misma clave, verificar correspondencia estricta de payload
      const existing = await this.invoiceRepo.findLatestByIdempotencyKey(tenantId, input.idempotencyKey);
      // Una venta REJECTED/CANCELLED no se facturó y su clave ya fue liberada: el POS puede reenviarla corregida
      if (existing && existing.status !== 'REJECTED' && existing.status !== 'CANCELLED') {
        // A. Verificar requestHash en la tabla de claves de idempotencia si está registrado
        const db = getDatabase();
        const [existingKeyRecord] = await db
          .select({ requestHash: idempotencyKeys.requestHash })
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, input.idempotencyKey)))
          .limit(1);

        if (existingKeyRecord?.requestHash && existingKeyRecord.requestHash !== requestHash) {
          throw new IdempotencyKeyMismatchError();
        }

        // B. Comparar datos del comprobante existente contra los datos del input
        const calc = TaxCalculator.calculate(input.items, input.voucherType, input.pricesIncludeVat !== false);
        const totalMatches = Math.abs(Number(existing.totalAmount) - calc.totalAmount) < 0.01;
        const voucherTypeMatches = existing.voucherType === input.voucherType;
        const ptoVtaMatches = existing.pointOfSaleNumber === input.pointOfSaleNumber;

        if (!totalMatches || !voucherTypeMatches || !ptoVtaMatches) {
          throw new IdempotencyKeyMismatchError();
        }

        if (existing.status === 'AUTHORIZED') {
          return this.getInvoiceById(tenantId, existing.id);
        }
        if (existing.status === 'PENDING_RECONCILIATION' || existing.status === 'PENDING') {
          let resolved: FullInvoice | undefined;
          try {
            resolved = await this.reconcileInvoice(tenantId, existing.id, userId);
          } catch (err) {
            // El número quedó tomado por un comprobante de otro sistema: la venta anterior quedó REJECTED y la
            // clave liberada, así que se continúa con una emisión nueva en esta misma solicitud (N2c).
            if (!(err instanceof ConflictError && (err.details as { code?: string } | undefined)?.code === FOREIGN_VOUCHER_CODE)) {
              throw err;
            }
          }
          if (resolved?.status === 'AUTHORIZED') {
            return resolved;
          }
        }
      }

      let idemp = await IdempotencyService.acquire(tenantId, input.idempotencyKey, 'invoices', idempOptions);
      if (idemp.state === 'IN_PROGRESS') {
        idemp = await IdempotencyService.waitForCompletion(tenantId, input.idempotencyKey, idempOptions);
      }
      if (idemp.state === 'IN_PROGRESS') {
        throw new ConflictError(
          'Una solicitud de emisión idéntica con esta misma clave de idempotencia se encuentra actualmente en procesamiento'
        );
      }
      if (idemp.state === 'CACHED') {
        logger.info({ key: input.idempotencyKey }, 'Retornando factura previamente autorizada desde caché de idempotencia');
        return idemp.responseBody as FullInvoice;
      }
    }

    // 2. Control de emisiones concurrentes en vuelo por comercio (evita DoS cross-tenant).
    // Solo las solicitudes que realmente ejecutan una emisión toman un slot en el limiter.
    const config = loadConfig();
    const inFlightAcquired = TenantInFlightLimiter.tryAcquire(
      tenantId,
      config.MAX_IN_FLIGHT_EMISSIONS_PER_TENANT
    );
    if (!inFlightAcquired) {
      // Si el comercio está saturado, liberar la clave de idempotencia inmediatamente
      // para que futuros reintentos del POS no queden bloqueados con 409 Conflict.
      if (input.idempotencyKey) {
        await IdempotencyService.release(tenantId, input.idempotencyKey).catch(() => {});
      }
      // R7: Responder 429 con Retry-After en lugar de 503 cuando se saturan las emisiones del comercio
      throw new TenantConcurrencyLimitError(
        'El comercio ha alcanzado el límite de emisiones concurrentes permitidas. Reintente en unos segundos.',
        2
      );
    }

    try {
      // 3. Validaciones fiscales y de comprobantes asociados ANTES de adquirir bloqueos
      this.validateFiscalRules(input);
      await this.assertCustomerBelongsToTenant(tenantId, input.customerId);
      await this.assertProductsBelongToTenant(tenantId, input.items);
      const { identity } = await this.loadIdentityAndCertificate(tenantId, input.fiscalIdentityId);

      const ptos = await this.fiscalRepo.getPointsOfSale(identity.id);
      const ptoRecord = ptos.find((p) => p.number === input.pointOfSaleNumber && p.active);
      if (!ptoRecord) {
        throw new ValidationError(
          `El punto de venta ${input.pointOfSaleNumber} no está configurado o no se encuentra activo para la identidad fiscal ${identity.cuit}`
        );
      }

      if (input.associatedVouchers && input.associatedVouchers.length > 0) {
        await this.validateAssociatedVouchersExistence(identity, input, userRole);
      }

      // 4. Armar conjunto único de claves de bloqueo (secuencia fiscal + comprobantes asociados)
      // Se adquieren todas bajo UNA SOLA conexión de PostgreSQL para no agotar el pool de bloqueos (N1).
      const isCreditOrDebit = isCreditNote(input.voucherType) || isDebitNote(input.voucherType);
      const associatedRefs: AssociatedVoucherRef[] =
        isCreditOrDebit && input.associatedVouchers ? input.associatedVouchers : [];

      // Las claves van por entorno + CUIT (no por identidad fiscal): dos identidades con el mismo CUIT,
      // aunque sean de comercios distintos, comparten la numeración en ARCA (N4).
      const owner = sequenceOwner(identity);
      const allLockKeys = [
        FiscalLock.buildKey(owner, input.pointOfSaleNumber, input.voucherType),
        ...associatedRefs.map((a) =>
          AssociatedVoucherLock.buildKey(owner, a.pointOfSale, a.voucherType, a.voucherNumber)
        )
      ];

      let result: FullInvoice;
      try {
        result = await withAdvisoryLocks(
          allLockKeys,
          () => this.executeFiscalEmission(tenantId, input, userId, userRole),
          {
            timeoutMs: config.FISCAL_LOCK_TIMEOUT_MS,
            maxQueueSize: config.MAX_QUEUE_PER_SEQUENCE,
            retryAfterSeconds: 5,
            busyMessage: `El punto de venta ${input.pointOfSaleNumber} o el comprobante asociado está procesando otras emisiones. Reintente en unos segundos.`
          }
        );
      } catch (err) {
        if (input.idempotencyKey && !(err instanceof InfrastructureError && err.code === PENDING_RECONCILIATION_CODE)) {
          await IdempotencyService.release(tenantId, input.idempotencyKey).catch(() => {});
        }
        throw err;
      }

      // El comprobante ya está autorizado: un fallo al cachear la respuesta no debe liberar la clave
      // (un reintento la encontrará vía findLatestByIdempotencyKey / conciliación).
      if (input.idempotencyKey) {
        await IdempotencyService.complete(tenantId, input.idempotencyKey, 201, result).catch((err: unknown) => {
          logger.error({ err, invoiceId: result.id }, 'No se pudo registrar el resultado de idempotencia');
        });
      }

      return result;
    } catch (outerErr) {
      if (input.idempotencyKey && !(outerErr instanceof InfrastructureError && outerErr.code === PENDING_RECONCILIATION_CODE)) {
        await IdempotencyService.release(tenantId, input.idempotencyKey).catch(() => {});
      }
      throw outerErr;
    } finally {
      TenantInFlightLimiter.release(tenantId);
    }
  }

  /**
   * Flujo nuclear de validación fiscal, obtención de ticket WSAA y solicitud de CAE ante WSFEv1
   */
  private async executeFiscalEmission(
    tenantId: string,
    input: EmitInvoiceInput,
    userId?: string,
    userRole?: string
  ): Promise<FullInvoice> {
    // A. Validar identidad fiscal y certificado activo
    const { identity, cert } = await this.loadIdentityAndCertificate(tenantId, input.fiscalIdentityId);
    const environment = identity.environment as ArcaEnvironment;

    if (identity.status !== 'CONNECTED') {
      throw new ValidationError(
        `La identidad fiscal ${identity.cuit} no está habilitada para emitir (estado ${identity.status}). Ejecute la prueba de conexión con ARCA.`
      );
    }
    if (cert.validTo && cert.validTo.getTime() <= Date.now()) {
      throw new ValidationError(
        `El certificado de la identidad fiscal ${identity.cuit} venció el ${cert.validTo.toISOString().slice(0, 10)}. Renuévelo para seguir emitiendo.`
      );
    }

    // B. Validar punto de venta activo
    const ptos = await this.fiscalRepo.getPointsOfSale(identity.id);
    const ptoRecord = ptos.find((p) => p.number === input.pointOfSaleNumber && p.active);
    if (!ptoRecord) {
      throw new ValidationError(
        `El punto de venta ${input.pointOfSaleNumber} no está configurado o no se encuentra activo para la identidad fiscal ${identity.cuit}`
      );
    }

    // C. Validaciones fiscales según normativa ARCA
    this.validateFiscalRules(input);
    await this.assertCustomerBelongsToTenant(tenantId, input.customerId);

    const docType = input.customer?.docType ?? 99;
    const docNumber = this.normalizeDocNumber(input);
    const customerName = input.customer?.name ?? (docType === 99 ? 'Consumidor Final' : 'Cliente');
    const voucherLetter = getVoucherLetter(input.voucherType);
    const concept = input.concept ?? 1;

    // D. Motor de cálculo impositivo
    const pricesIncludeVat = input.pricesIncludeVat !== false;
    const calc = TaxCalculator.calculate(input.items, input.voucherType, pricesIncludeVat);

    // D.2 Validar comprobantes asociados localmente y disponibilidad de saldo
    await this.validateAssociatedVouchers(tenantId, identity, input, calc.totalAmount, userRole);

    // E. Desencriptar clave privada y obtener credenciales WSAA
    const wsfeAuth = await this.getWsfeAuth(identity, cert);

    const seqKey = SequenceNumberCache.buildKey(sequenceOwner(identity), input.pointOfSaleNumber, input.voucherType);

    // F. Conciliar emisiones previas interrumpidas de esta secuencia.
    const staleCount = await this.resolveStaleInSequence(identity, wsfeAuth, input.pointOfSaleNumber, input.voucherType, userId);
    if (staleCount > 0) {
      SequenceNumberCache.invalidate(seqKey);
    }

    // G. Obtener próximo número de comprobante desde caché o consultando a ARCA
    let lastNumber = SequenceNumberCache.get(seqKey);
    let fromCache = false;

    if (lastNumber === undefined) {
      lastNumber = await Wsfev1Client.getUltimoComprobante(
        wsfeAuth,
        input.pointOfSaleNumber,
        input.voucherType,
        { environment }
      );
      SequenceNumberCache.set(seqKey, lastNumber);
    } else {
      fromCache = true;
    }
    let nextVoucherNumber = lastNumber + 1;

    let clash = await this.invoiceRepo.findBySequenceNumber(
      identity.id,
      input.pointOfSaleNumber,
      input.voucherType,
      nextVoucherNumber
    );

    if (clash && fromCache) {
      SequenceNumberCache.invalidate(seqKey);
      lastNumber = await Wsfev1Client.getUltimoComprobante(
        wsfeAuth,
        input.pointOfSaleNumber,
        input.voucherType,
        { environment }
      );
      SequenceNumberCache.set(seqKey, lastNumber);
      nextVoucherNumber = lastNumber + 1;
      clash = await this.invoiceRepo.findBySequenceNumber(
        identity.id,
        input.pointOfSaleNumber,
        input.voucherType,
        nextVoucherNumber
      );
    }

    if (clash) {
      SequenceNumberCache.invalidate(seqKey);
      throw new ConflictError(
        `La numeración local está desincronizada con ARCA: el número ${input.pointOfSaleNumber}-${nextVoucherNumber} ya está asignado al comprobante ${clash.id} (estado ${clash.status}). Concílielo antes de volver a emitir.`,
        { invoiceId: clash.id, status: clash.status, voucherNumber: nextVoucherNumber }
      );
    }

    // H. Crear el registro preliminar en base de datos con status PENDING
    const draftInvoice = await this.invoiceRepo.createWithDetails(
      {
        tenantId,
        fiscalIdentityId: identity.id,
        pointOfSaleNumber: input.pointOfSaleNumber,
        voucherType: input.voucherType,
        voucherLetter,
        voucherNumber: nextVoucherNumber,
        concept,
        serviceDateFrom: input.serviceDateFrom ? isoDateToArgentinaNoon(input.serviceDateFrom) : undefined,
        serviceDateTo: input.serviceDateTo ? isoDateToArgentinaNoon(input.serviceDateTo) : undefined,
        paymentDueDate: input.paymentDueDate ? isoDateToArgentinaNoon(input.paymentDueDate) : undefined,
        status: 'PENDING',
        totalAmount: calc.totalAmount.toFixed(2),
        netTaxedAmount: calc.netTaxedAmount.toFixed(2),
        netUntaxedAmount: calc.netUntaxedAmount.toFixed(2),
        exemptAmount: calc.exemptAmount.toFixed(2),
        vatAmount: calc.vatAmount.toFixed(2),
        specialTaxesAmount: calc.specialTaxesAmount.toFixed(2),
        customerId: input.customerId,
        customerDocType: docType,
        customerDocNumber: docNumber,
        customerName,
        customerTaxCondition: this.resolveReceptorIvaCondition(input),
        customerAddress: input.customer?.address,
        notes: input.notes,
        posSaleId: input.posSaleId,
        idempotencyKey: input.idempotencyKey
      },
      calc.items.map((it) => ({
        productId: it.productId,
        internalCode: it.internalCode,
        description: it.description,
        quantity: it.quantity.toFixed(4),
        unitPrice: it.unitPrice.toFixed(4),
        discount: it.discount.toFixed(4),
        vatRate: it.vatRate.toFixed(2),
        vatAfipCode: it.vatAfipCode,
        netSubtotal: it.netSubtotal.toFixed(2),
        vatSubtotal: it.vatSubtotal.toFixed(2),
        totalSubtotal: it.totalSubtotal.toFixed(2)
      })),
      calc.vatSubtotals.map((v) => ({
        vatAfipCode: v.vatAfipCode,
        vatRate: v.vatRate.toFixed(2),
        baseAmount: v.baseAmount.toFixed(2),
        vatAmount: v.vatAmount.toFixed(2)
      })),
      (input.associatedVouchers ?? []).map((a) => ({
        associatedVoucherType: a.voucherType,
        pointOfSale: a.pointOfSale,
        voucherNumber: a.voucherNumber,
        cuit: a.cuit
      }))
    );

    // I. Formatear fechas para ARCA (YYYYMMDD). Las fechas calendario se convierten sin pasar por zonas horarias.
    const now = new Date();
    const cbteFch = this.formatDateYyyyMmDd(now);
    const fchServDesde = input.serviceDateFrom ? isoDateToAfip(input.serviceDateFrom) : undefined;
    const fchServHasta = input.serviceDateTo ? isoDateToAfip(input.serviceDateTo) : undefined;
    const fchVtoPago = input.paymentDueDate ? isoDateToAfip(input.paymentDueDate) : undefined;

    // J. Solicitar autorización fiscal (CAE) a WSFEv1
    const sendSolicitarCae = async (voucherNum: number) => {
      try {
        return await Wsfev1Client.solicitarCae(
          wsfeAuth,
          {
            ptoVta: input.pointOfSaleNumber,
            cbteTipo: input.voucherType,
            detalle: {
              concepto: concept,
              docTipo: docType,
              docNro: docNumber || 0,
              cbteDesde: voucherNum,
              cbteHasta: voucherNum,
              cbteFch,
              impTotal: calc.totalAmount,
              impTotConc: calc.netUntaxedAmount,
              impNeto: calc.netTaxedAmount,
              impOpEx: calc.exemptAmount,
              impTrib: calc.specialTaxesAmount,
              impIVA: calc.vatAmount,
              fchServDesde,
              fchServHasta,
              fchVtoPago,
              monId: 'PES',
              monCotiz: 1,
              condicionIvaReceptorId: this.resolveReceptorIvaCondition(input),
              cbtesAsoc: input.associatedVouchers?.map((a) => ({
                tipo: a.voucherType,
                ptoVta: a.pointOfSale,
                nro: a.voucherNumber,
                cuit: a.cuit
              })),
              iva: requiresVatBreakdown(input.voucherType)
                ? calc.vatSubtotals.map((v) => ({
                    id: v.vatAfipCode,
                    baseImp: v.baseAmount,
                    importe: v.vatAmount
                  }))
                : undefined
            }
          },
          { environment }
        );
      } catch (err: unknown) {
        SequenceNumberCache.invalidate(seqKey);
        // Manejo de corte de conexión o timeout durante la emisión: NO reintentar a ciegas.
        // Marcamos el comprobante como PENDING_RECONCILIATION para que sea conciliado sin duplicar numeración.
        // Si este update también falla, el registro queda en PENDING y se concilia en la próxima emisión de la secuencia.
        // M3: Preservar notes intacto (observaciones comerciales del cliente) y almacenar el error en afipErrors
        await this.invoiceRepo
          .update(tenantId, draftInvoice.id, {
            status: 'PENDING_RECONCILIATION',
            afipErrors: [
              {
                code: 'COMMUNICATION_TIMEOUT',
                message: `Interrupción en la comunicación con ARCA: ${err instanceof Error ? err.message : String(err)}`
              }
            ]
          })
          .catch((updateErr: unknown) => {
            logger.error({ invoiceId: draftInvoice.id, err: updateErr }, 'No se pudo marcar el comprobante como PENDING_RECONCILIATION');
          });

        logger.warn(
          { invoiceId: draftInvoice.id, err },
          'Interrupción de red durante FECAESolicitar. Comprobante guardado como PENDING_RECONCILIATION'
        );

        throw new InfrastructureError(
          'Se produjo un timeout o error de comunicación con ARCA. El comprobante fue registrado con estado PENDING_RECONCILIATION: reintente con la misma clave de idempotencia o concílielo con POST /api/v1/invoices/:id/reconcile.',
          PENDING_RECONCILIATION_CODE,
          { invoiceId: draftInvoice.id }
        );
      }
    };

    let caeResponse = await sendSolicitarCae(nextVoucherNumber);

    // Si ARCA rechazó por error 10016 (desincronización de numeración) y venía de caché, refrescar y reintentar
    const has10016 = caeResponse.resultado === 'R' && caeResponse.errores.some((e) => e.code === 10016);
    if (has10016) {
      SequenceNumberCache.invalidate(seqKey);
      if (fromCache) {
        logger.warn(
          { seqKey, oldNumber: nextVoucherNumber },
          'Error ARCA 10016 en numeración cacheada; sincronizando con FECompUltimoAutorizado y reintentando'
        );
        let refreshedLast: number;
        try {
          refreshedLast = await Wsfev1Client.getUltimoComprobante(
            wsfeAuth,
            input.pointOfSaleNumber,
            input.voucherType,
            { environment }
          );
        } catch (refreshErr) {
          logger.error(
            { refreshErr, invoiceId: draftInvoice.id },
            'Fallo al consultar getUltimoComprobante tras error 10016. Marcando comprobante preliminar como REJECTED'
          );
          await this.invoiceRepo
            .update(tenantId, draftInvoice.id, {
              status: 'REJECTED',
              voucherNumber: null,
              afipResult: 'R',
              // M3: el motivo va en afipErrors; notes son las observaciones comerciales del POS
              afipErrors: [
                ...caeResponse.errores,
                {
                  code: 'SEQUENCE_REFRESH_FAILED',
                  message: `Rechazado por numeración desincronizada (ARCA 10016) y fallo al consultar último comprobante: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`
                }
              ]
            })
            .catch(() => {});
          throw new FiscalError(
            'ARCA rechazó el comprobante por numeración desincronizada (error 10016) y no se pudo obtener el último número autorizado de ARCA. El comprobante fue marcado como REJECTED; reintente la emisión.',
            caeResponse.errores
          );
        }

        SequenceNumberCache.set(seqKey, refreshedLast);
        if (refreshedLast > lastNumber) {
          // ARCA autorizó números que esta API no emitió: otro sistema usa el mismo CUIT y punto de venta
          logger.warn(
            { cuit: identity.cuit, ptoVta: input.pointOfSaleNumber, cbteTipo: input.voucherType, expected: lastNumber, arca: refreshedLast },
            'Emisión externa detectada: ARCA tiene comprobantes en esta secuencia que no emitió la API'
          );
          await AuditService.record({
            tenantId,
            userId,
            action: 'FOREIGN_EMISSION_DETECTED',
            entityType: 'fiscal_identity',
            entityId: identity.id,
            payload: { pointOfSale: input.pointOfSaleNumber, voucherType: input.voucherType, expectedLast: lastNumber, arcaLast: refreshedLast }
          }).catch(() => {});
        }
        nextVoucherNumber = refreshedLast + 1;

        await this.invoiceRepo.update(tenantId, draftInvoice.id, { voucherNumber: nextVoucherNumber });

        caeResponse = await sendSolicitarCae(nextVoucherNumber);
      }
    }

    // K. Procesar resultado de ARCA
    if (caeResponse.resultado === 'A') {
      SequenceNumberCache.set(seqKey, nextVoucherNumber);
      const caeExpiresAt = caeResponse.caeFchVto ? this.parseAfipDate(caeResponse.caeFchVto) : undefined;
      const qrData = FiscalQrGenerator.buildQrUrl({
        ver: 1,
        fecha: this.formatDateIso(now),
        cuit: Number(identity.cuit),
        ptoVta: input.pointOfSaleNumber,
        tipoCmp: input.voucherType,
        nroCmp: nextVoucherNumber,
        importe: calc.totalAmount,
        moneda: 'PES',
        ctz: 1,
        tipoDocRec: docType,
        nroDocRec: Number(docNumber) || 0,
        tipoCodAut: 'E',
        codAut: Number(caeResponse.cae ?? 0)
      });

      try {
        await this.invoiceRepo.update(tenantId, draftInvoice.id, {
          status: 'AUTHORIZED',
          cae: caeResponse.cae,
          caeExpiresAt,
          afipResult: 'A',
          afipXmlRequest: caeResponse.xmlRequest,
          afipXmlResponse: caeResponse.xmlResponse,
          afipObservations: caeResponse.observaciones,
          afipEvents: caeResponse.eventos,
          qrData
        });
      } catch (persistErr: unknown) {
        // ARCA ya autorizó el comprobante: nunca liberar la idempotencia ni dejar que el POS emita otro.
        // El CAE queda en el log y el comprobante se recupera conciliando con FECompConsultar.
        logger.error(
          {
            err: persistErr,
            invoiceId: draftInvoice.id,
            cuit: identity.cuit,
            ptoVta: input.pointOfSaleNumber,
            cbteTipo: input.voucherType,
            cbteNro: nextVoucherNumber,
            cae: caeResponse.cae
          },
          'CAE otorgado por ARCA pero no se pudo persistir el comprobante autorizado'
        );
        await this.invoiceRepo
          .update(tenantId, draftInvoice.id, { status: 'PENDING_RECONCILIATION' })
          .catch(() => {});
        throw new InfrastructureError(
          'ARCA autorizó el comprobante pero no se pudo registrar localmente. Quedó en estado PENDING_RECONCILIATION: reintente con la misma clave de idempotencia o concílielo con POST /api/v1/invoices/:id/reconcile.',
          PENDING_RECONCILIATION_CODE,
          { invoiceId: draftInvoice.id }
        );
      }

      await AuditService.record({
        tenantId,
        userId,
        action: 'INVOICE_AUTHORIZED',
        entityType: 'invoice',
        entityId: draftInvoice.id
      });

      // R8: una NC/ND sobre comprobantes de otro CUIT no tiene control de saldo local; queda trazada en auditoría
      const thirdParty = (input.associatedVouchers ?? []).filter(
        (a) => a.cuit && cleanDocumentNumber(a.cuit) !== cleanDocumentNumber(identity.cuit)
      );
      if (thirdParty.length > 0) {
        await AuditService.record({
          tenantId,
          userId,
          action: 'THIRD_PARTY_ASSOCIATED_VOUCHER_AUTHORIZED',
          entityType: 'invoice',
          entityId: draftInvoice.id,
          payload: { voucherType: input.voucherType, totalAmount: calc.totalAmount, associated: thirdParty, role: userRole }
        }).catch(() => {});
      }

      const updated = await this.invoiceRepo.findById(tenantId, draftInvoice.id);
      return updated!;
    } else {
      SequenceNumberCache.invalidate(seqKey);
      // Rechazado por ARCA: liberamos el voucherNumber en el registro rechazado para que no bloquee la numeración fiscal legal
      await this.invoiceRepo.update(tenantId, draftInvoice.id, {
        status: 'REJECTED',
        voucherNumber: null,
        afipResult: 'R',
        afipXmlRequest: caeResponse.xmlRequest,
        afipXmlResponse: caeResponse.xmlResponse,
        afipErrors: caeResponse.errores,
        afipObservations: caeResponse.observaciones
      });

      const allDetails = [
        ...caeResponse.errores.map((e) => `[Error ${e.code}] ${e.message}`),
        ...caeResponse.observaciones.map((o) => `[Obs ${o.code}] ${o.message}`)
      ];
      const errorMsg = allDetails.join(', ');
      throw new FiscalError(`Comprobante rechazado por ARCA: ${errorMsg || 'Rechazado sin detalle'}`, [
        ...caeResponse.errores,
        ...caeResponse.observaciones
      ]);
    }
  }

  /**
   * Concilia con ARCA (FECompConsultar) un comprobante cuya emisión quedó interrumpida
   * (PENDING o PENDING_RECONCILIATION). Corre bajo el FiscalLock de la secuencia para no
   * competir con una emisión en curso.
   */
  public async reconcileInvoice(
    tenantId: string,
    invoiceId: string,
    userId?: string
  ): Promise<FullInvoice> {
    const invoice = await this.invoiceRepo.findById(tenantId, invoiceId);
    if (!invoice) {
      throw new NotFoundError(`Comprobante con ID "${invoiceId}" no encontrado`);
    }

    if (!UNRESOLVED_STATUSES.includes(invoice.status) || invoice.voucherNumber === null) {
      throw new ValidationError(
        `El comprobante se encuentra en estado "${invoice.status}", solo los comprobantes en "PENDING" o "PENDING_RECONCILIATION" pueden ser conciliados`
      );
    }

    const { identity, cert } = await this.loadIdentityAndCertificate(tenantId, invoice.fiscalIdentityId);

    const owner = sequenceOwner(identity);
    return FiscalLock.withLock(owner, invoice.pointOfSaleNumber, invoice.voucherType, async () => {
      SequenceNumberCache.invalidate(SequenceNumberCache.buildKey(owner, invoice.pointOfSaleNumber, invoice.voucherType));
      // Releer bajo el lock: otra petición pudo haberlo resuelto mientras esperábamos
      const current = await this.invoiceRepo.findById(tenantId, invoiceId);
      if (!current || !UNRESOLVED_STATUSES.includes(current.status) || current.voucherNumber === null) {
        return current ?? invoice;
      }

      const wsfeAuth = await this.getWsfeAuth(identity, cert);
      await this.resolveAgainstArca(current, identity, wsfeAuth, userId);

      const updated = await this.invoiceRepo.findById(tenantId, invoiceId);
      return updated!;
    });
  }

  /**
   * Debe llamarse con el FiscalLock de la secuencia tomado: cualquier comprobante PENDING encontrado es de
   * una emisión que ya terminó (o murió) sin registrar su resultado.
   */
  private async resolveStaleInSequence(
    identity: FiscalIdentity,
    wsfeAuth: WsfeAuth,
    pointOfSaleNumber: number,
    voucherType: number,
    userId?: string
  ): Promise<number> {
    const stale = await this.invoiceRepo.findUnresolvedInSequence(identity.id, pointOfSaleNumber, voucherType);
    for (const inv of stale) {
      try {
        await this.resolveAgainstArca(inv, identity, wsfeAuth, userId);
      } catch (err) {
        // Si no se puede determinar el estado, el control de colisión de numeración evita duplicar el número
        logger.warn({ err, invoiceId: inv.id }, 'No se pudo conciliar automáticamente un comprobante pendiente');
      }
    }
    return stale.length;
  }

  /**
   * Determina con FECompConsultar el resultado real de un comprobante numerado:
   * - Existe en ARCA: se marca AUTHORIZED con su CAE.
   * - ARCA responde "sin resultados" (602): se marca CANCELLED y se libera la numeración.
   * - Cualquier otra respuesta: se mantiene pendiente y se lanza un error.
   */
  private async resolveAgainstArca(
    invoice: Invoice,
    identity: FiscalIdentity,
    wsfeAuth: WsfeAuth,
    userId?: string
  ): Promise<'AUTHORIZED' | 'CANCELLED'> {
    const voucherNumber = invoice.voucherNumber!;
    const consult = await Wsfev1Client.consultarComprobante(
      wsfeAuth,
      invoice.pointOfSaleNumber,
      invoice.voucherType,
      voucherNumber,
      { environment: identity.environment as ArcaEnvironment }
    );

    if (consult.encontrado && consult.cae) {
      // Comparar que el comprobante en ARCA corresponda estrictamente a esta venta
      // para evitar asignar el CAE de un comprobante ajeno emitido por otro sistema (N2).
      let mismatch = false;
      let mismatchReason = '';

      if (consult.impTotal !== undefined && consult.impTotal !== null) {
        const arcaTotal = Number(consult.impTotal);
        const localTotal = Number(invoice.totalAmount);
        if (Math.abs(arcaTotal - localTotal) >= 0.01) {
          mismatch = true;
          mismatchReason = `total ARCA $${arcaTotal} vs local $${localTotal}`;
        }
      }

      const addReason = (reason: string) => {
        mismatch = true;
        mismatchReason = mismatchReason ? `${mismatchReason}, ${reason}` : reason;
      };
      if (consult.impNeto !== undefined && Math.abs(Number(consult.impNeto) - Number(invoice.netTaxedAmount)) >= 0.01) {
        addReason(`neto gravado ARCA $${consult.impNeto} vs local $${invoice.netTaxedAmount}`);
      }
      if (consult.impIVA !== undefined && Math.abs(Number(consult.impIVA) - Number(invoice.vatAmount)) >= 0.01) {
        addReason(`IVA ARCA $${consult.impIVA} vs local $${invoice.vatAmount}`);
      }

      // Momento en que ARCA procesó el comprobante: si cae fuera de la ventana de nuestra solicitud, es ajeno
      // aunque coincidan importe y receptor (N2b: otra venta igual a Consumidor Final desde otro sistema).
      const processedAt = this.parseAfipDateTime(consult.fchProceso);
      if (processedAt) {
        const sentAt = invoice.createdAt.getTime();
        if (
          processedAt.getTime() < sentAt - OWN_PROCESSING_WINDOW_BEFORE_MS ||
          processedAt.getTime() > sentAt + OWN_PROCESSING_WINDOW_AFTER_MS
        ) {
          addReason(`procesado por ARCA el ${processedAt.toISOString()}, fuera de la ventana de la solicitud (${invoice.createdAt.toISOString()})`);
        }
      }

      if (consult.docTipo !== undefined && consult.docNro !== undefined) {
        const arcaDocType = Number(consult.docTipo);
        const localDocType = Number(invoice.customerDocType);
        const arcaDocNum = String(consult.docNro).trim().replace(/^0+/, '') || '0';
        const localDocNum = String(invoice.customerDocNumber || '0').trim().replace(/^0+/, '') || '0';
        if (arcaDocType !== localDocType || arcaDocNum !== localDocNum) {
          mismatch = true;
          mismatchReason = mismatchReason
            ? `${mismatchReason}, receptor ARCA ${arcaDocType}:${arcaDocNum} vs local ${localDocType}:${localDocNum}`
            : `receptor ARCA ${arcaDocType}:${arcaDocNum} vs local ${localDocType}:${localDocNum}`;
        }
      }

      if (mismatch) {
        logger.error(
          {
            invoiceId: invoice.id,
            voucherNumber,
            expected: { total: invoice.totalAmount, docType: invoice.customerDocType, docNumber: invoice.customerDocNumber },
            arca: { total: consult.impTotal, docType: consult.docTipo, docNumber: consult.docNro, cae: consult.cae },
            reason: mismatchReason
          },
          'DISCORDANCIA CRÍTICA: Comprobante consultado en ARCA no coincide con el comprobante local. Pertenece a otra transacción.'
        );

        await this.invoiceRepo.update(invoice.tenantId, invoice.id, {
          status: 'REJECTED',
          voucherNumber: null,
          afipErrors: [
            {
              code: FOREIGN_VOUCHER_CODE,
              message: `Reconciliación rechazada por discordancia con ARCA: número ${invoice.pointOfSaleNumber}-${voucherNumber} pertenece a otro comprobante (${mismatchReason})`
            }
          ]
        });

        await AuditService.record({
          tenantId: invoice.tenantId,
          userId,
          action: 'INVOICE_RECONCILED_FOREIGN_VOUCHER',
          entityType: 'invoice',
          entityId: invoice.id,
          payload: { voucherNumber, reason: mismatchReason, arcaCae: consult.cae }
        }).catch(() => {});

        // La venta no se facturó: liberar la clave para que el POS pueda reintentarla (N2c)
        if (invoice.idempotencyKey) {
          await IdempotencyService.release(invoice.tenantId, invoice.idempotencyKey);
        }

        throw new ConflictError(
          `El comprobante ${invoice.pointOfSaleNumber}-${voucherNumber} registrado en ARCA no corresponde a esta venta (${mismatchReason}). La venta local fue marcada como REJECTED para prevenir asignación errónea de CAE; reintente la emisión con la misma clave de idempotencia.`,
          { code: FOREIGN_VOUCHER_CODE, invoiceId: invoice.id, voucherNumber }
        );
      }

      const caeExpiresAt = consult.caeFchVto ? this.parseAfipDate(consult.caeFchVto) : undefined;
      const fecha =
        consult.cbteFch && /^\d{8}$/.test(consult.cbteFch)
          ? `${consult.cbteFch.slice(0, 4)}-${consult.cbteFch.slice(4, 6)}-${consult.cbteFch.slice(6, 8)}`
          : this.formatDateIso(invoice.issueDate);
      const qrData = FiscalQrGenerator.buildQrUrl({
        ver: 1,
        fecha,
        cuit: Number(identity.cuit),
        ptoVta: invoice.pointOfSaleNumber,
        tipoCmp: invoice.voucherType,
        nroCmp: voucherNumber,
        importe: Number(invoice.totalAmount),
        moneda: invoice.currency,
        ctz: Number(invoice.currencyRate),
        tipoDocRec: invoice.customerDocType,
        nroDocRec: Number(invoice.customerDocNumber) || 0,
        tipoCodAut: 'E',
        codAut: Number(consult.cae)
      });

      await this.invoiceRepo.update(invoice.tenantId, invoice.id, {
        status: 'AUTHORIZED',
        cae: consult.cae,
        caeExpiresAt,
        afipResult: 'A',
        afipErrors: null, // el corte de comunicación ya quedó resuelto
        afipObservations: consult.observaciones,
        qrData
      });

      await AuditService.record({
        tenantId: invoice.tenantId,
        userId,
        action: 'INVOICE_RECONCILED_AUTHORIZED',
        entityType: 'invoice',
        entityId: invoice.id
      });

      if (invoice.idempotencyKey) {
        const full = await this.invoiceRepo.findById(invoice.tenantId, invoice.id);
        await IdempotencyService.complete(invoice.tenantId, invoice.idempotencyKey, 201, full);
      }

      return 'AUTHORIZED';
    }

    // 602 = "Sin resultados": ARCA no tiene registrado el comprobante con ese número
    const notRegistered = consult.errores.length > 0 && consult.errores.every((e) => Number(e.code) === 602);
    if (!notRegistered) {
      const detail = consult.errores.map((e) => `[${e.code}] ${e.message}`).join(', ') || 'respuesta sin datos';
      throw new InfrastructureError(
        `ARCA no confirmó el estado del comprobante ${invoice.pointOfSaleNumber}-${voucherNumber} (${detail}). Sigue pendiente de conciliación.`,
        PENDING_RECONCILIATION_CODE,
        { invoiceId: invoice.id }
      );
    }

    // Nunca llegó a ARCA: se libera el número para que la secuencia fiscal pueda continuar
    await this.invoiceRepo.update(invoice.tenantId, invoice.id, {
      status: 'CANCELLED',
      voucherNumber: null,
      afipErrors: [
        { code: 'NOT_REGISTERED_IN_ARCA', message: `Comprobante no registrado en ARCA tras consulta de reconciliación (número ${voucherNumber} liberado)` }
      ]
    });

    await AuditService.record({
      tenantId: invoice.tenantId,
      userId,
      action: 'INVOICE_RECONCILED_NOT_FOUND',
      entityType: 'invoice',
      entityId: invoice.id,
      payload: { releasedVoucherNumber: voucherNumber }
    });

    if (invoice.idempotencyKey) {
      await IdempotencyService.release(invoice.tenantId, invoice.idempotencyKey);
    }

    return 'CANCELLED';
  }

  private async loadIdentityAndCertificate(
    tenantId: string,
    fiscalIdentityId: string
  ): Promise<{ identity: FiscalIdentity; cert: FiscalCertificate & { certificate: string } }> {
    const identity = await this.fiscalRepo.findById(tenantId, fiscalIdentityId);
    if (!identity) {
      throw new NotFoundError(`Identidad fiscal con ID "${fiscalIdentityId}" no encontrada`);
    }

    const cert = await this.fiscalRepo.getActiveCertificate(identity.id);
    if (!cert || !cert.certificate) {
      throw new ValidationError(
        `La identidad fiscal ${identity.cuit} no posee un certificado X.509 activo emitido por ARCA`
      );
    }

    return { identity, cert: { ...cert, certificate: cert.certificate } };
  }

  private async getWsfeAuth(
    identity: FiscalIdentity,
    cert: FiscalCertificate & { certificate: string }
  ): Promise<WsfeAuth> {
    const privateKeyPem = EncryptionService.decrypt({
      ciphertext: cert.encryptedPrivateKey,
      iv: cert.privateKeyIv,
      authTag: cert.privateKeyAuthTag
    });

    const wsaaCreds = await WsaaClient.getTicket(identity.id, privateKeyPem, cert.certificate, {
      environment: identity.environment as ArcaEnvironment,
      service: 'wsfe'
    });

    return {
      token: wsaaCreds.token,
      sign: wsaaCreds.sign,
      cuit: identity.cuit
    };
  }

  public async getInvoiceById(tenantId: string, id: string): Promise<FullInvoice> {
    const invoice = await this.invoiceRepo.findById(tenantId, id);
    if (!invoice) {
      throw new NotFoundError(`Comprobante con ID "${id}" no encontrado`);
    }
    return invoice;
  }

  public async listInvoices(tenantId: string, filters: InvoiceListFilters = {}) {
    return this.invoiceRepo.list(tenantId, filters);
  }

  /**
   * Huella de la operación para idempotencia: normaliza los valores por defecto para que un reintento
   * equivalente (p. ej. sin repetir vatRate: 21) no se considere un payload distinto.
   */
  private fingerprint(input: EmitInvoiceInput): unknown {
    const { idempotencyKey: _key, items, ...rest } = input;
    return {
      ...rest,
      concept: input.concept ?? 1,
      pricesIncludeVat: input.pricesIncludeVat !== false,
      items: items.map((it) => {
        const vat = resolveItemVat(it.vatRate, it.vatAfipCode);
        return { ...it, discount: it.discount ?? 0, vatRate: vat.rate, vatAfipCode: vat.afipCode };
      })
    };
  }

  private formatDateYyyyMmDd(d: Date): string {
    const formatter = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    return `${y}${m}${day}`;
  }

  private formatDateIso(d: Date): string {
    const formatter = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    return `${y}-${m}-${day}`;
  }

  /** FchProceso de ARCA (yyyymmddhhmmss, hora argentina UTC-3) → Date; undefined si no viene o es inválida */
  private parseAfipDateTime(value: string | undefined): Date | undefined {
    const m = value ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim()) : null;
    if (!m) return undefined;
    const [, y, mo, d, h, mi, se] = m.map(Number) as [number, number, number, number, number, number, number];
    return new Date(Date.UTC(y, mo - 1, d, h + 3, mi, se));
  }

  private parseAfipDate(dateStr: string): Date {
    // Format YYYYMMDD
    const y = parseInt(dateStr.substring(0, 4), 10);
    const m = parseInt(dateStr.substring(4, 6), 10) - 1;
    const d = parseInt(dateStr.substring(6, 8), 10);
    return new Date(Date.UTC(y, m, d, 23, 59, 59));
  }

  /**
   * Condición frente al IVA del receptor (CondicionIVAReceptorId, obligatoria en WSFEv1 según RG 5616).
   * Sólo se infiere cuando es inequívoca; con receptor identificado por CUIT/CUIL/CDI en B o C debe informarse.
   */
  private resolveReceptorIvaCondition(input: EmitInvoiceInput): number {
    const explicit = input.customer?.taxCondition;
    if (explicit !== undefined) return explicit;
    if (getVoucherLetter(input.voucherType) === 'A') return 1;
    return 5; // Consumidor Final (DocTipo 99 / DNI); los demás casos los rechaza validateFiscalRules
  }

  private async assertCustomerBelongsToTenant(tenantId: string, customerId: string | undefined): Promise<void> {
    if (customerId && !(await this.customerRepo.findById(tenantId, customerId))) {
      throw new NotFoundError(`Cliente con ID "${customerId}" no encontrado`);
    }
  }

  // M6: Validar que los ítems con productId pertenezcan al comercio que emite
  private async assertProductsBelongToTenant(tenantId: string, items: InvoiceItemInput[]): Promise<void> {
    const productIds = [...new Set(items.map((it) => it.productId).filter((id): id is string => Boolean(id)))];
    if (productIds.length === 0) return;

    // Una sola consulta (hasta 500 ítems): no una por producto
    const found = new Set(await this.productRepo.findExistingIds(tenantId, productIds));
    const missing = productIds.find((id) => !found.has(id));
    if (missing) {
      throw new NotFoundError(`Producto con ID "${missing}" no encontrado para este comercio`);
    }
  }

  /** Número de documento del receptor sólo con dígitos ("20-30123456-7" → "20301234567") */
  private normalizeDocNumber(input: EmitInvoiceInput): string {
    const docType = input.customer?.docType ?? 99;
    const raw = input.customer?.docNumber;
    if (raw === undefined || raw.trim() === '') {
      return docType === 99 ? '0' : '';
    }
    // Sólo se toleran separadores habituales; cualquier otro carácter hace fallar la validación
    if (!/^[\d\s.-]+$/.test(raw)) {
      return raw;
    }
    return cleanDocumentNumber(raw) || (docType === 99 ? '0' : '');
  }

  private validateFiscalRules(input: EmitInvoiceInput): void {
    if (!input.items || input.items.length === 0) {
      throw new ValidationError('El comprobante debe contener al menos un ítem');
    }

    if (!SUPPORTED_VOUCHER_TYPES.includes(input.voucherType)) {
      throw new ValidationError(
        `Tipo de comprobante ${input.voucherType} no soportado. Valores admitidos: ${SUPPORTED_VOUCHER_TYPES.join(', ')}`
      );
    }

    const docType = input.customer?.docType ?? 99;
    const docNumber = this.normalizeDocNumber(input);

    // El número de documento viaja a ARCA dentro del XML: sólo dígitos
    if (docType === 99) {
      if (docNumber !== '0') {
        throw new ValidationError('Para Consumidor Final (DocTipo 99) el número de documento debe ser 0');
      }
    } else if (!/^\d{1,11}$/.test(docNumber) || Number(docNumber) === 0) {
      throw new ValidationError(`El número de documento del comprador "${input.customer?.docNumber ?? ''}" no es válido`);
    }

    for (const assoc of input.associatedVouchers ?? []) {
      if (assoc.cuit !== undefined && !isValidCuit(assoc.cuit)) {
        throw new ValidationError(`El CUIT del comprobante asociado "${assoc.cuit}" no es válido`);
      }
    }

    // Validación Factura A / NC A / ND A: receptor obligatorio con CUIT válido
    const voucherLetter = getVoucherLetter(input.voucherType);

    const taxCondition = input.customer?.taxCondition;
    if (taxCondition !== undefined && !RECEPTOR_IVA_CONDITIONS.includes(taxCondition)) {
      throw new ValidationError(
        `Condición frente al IVA del receptor ${taxCondition} inválida. Valores admitidos: ${RECEPTOR_IVA_CONDITIONS.join(', ')}`
      );
    }
    if (voucherLetter === 'A' && taxCondition !== undefined && !RECEPTOR_IVA_CONDITIONS_A.includes(taxCondition)) {
      throw new ValidationError(
        `Los comprobantes "A" sólo admiten receptores con condición ${RECEPTOR_IVA_CONDITIONS_A.join(', ')} (recibido ${taxCondition})`
      );
    }
    if (voucherLetter !== 'A' && [80, 86, 87].includes(docType) && taxCondition === undefined) {
      throw new ValidationError(
        'Con receptor identificado por CUIT/CUIL/CDI debe informarse customer.taxCondition (1=RI, 4=Exento, 5=Consumidor Final, 6=Monotributo, ...)'
      );
    }
    if (voucherLetter === 'A') {
      if (docType !== 80) {
        throw new ValidationError('Los comprobantes tipo "A" exigen identificar al comprador con CUIT (DocTipo 80)');
      }
      if (!isValidCuit(docNumber)) {
        throw new ValidationError(`El CUIT del comprador "${docNumber}" no es válido según algoritmo oficial Módulo 11`);
      }
    }

    // Validación Notas de Crédito / Débito: comprobantes asociados obligatorios
    if (isCreditNote(input.voucherType) || isDebitNote(input.voucherType)) {
      if (!input.associatedVouchers || input.associatedVouchers.length === 0) {
        throw new ValidationError(
          'Las Notas de Crédito y Débito exigen indicar al menos un comprobante asociado'
        );
      }
    }

    if (input.associatedVouchers && input.associatedVouchers.length > 5) {
      throw new ValidationError(
        `No se permite indicar más de 5 comprobantes asociados por operación (recibido ${input.associatedVouchers.length})`
      );
    }

    const dateFields = {
      serviceDateFrom: input.serviceDateFrom,
      serviceDateTo: input.serviceDateTo,
      paymentDueDate: input.paymentDueDate
    };
    for (const [field, value] of Object.entries(dateFields)) {
      if (value !== undefined && !isValidIsoDate(value)) {
        throw new ValidationError(`El campo ${field} debe ser una fecha válida con formato YYYY-MM-DD (recibido "${value}")`);
      }
    }

    // Validación conceptos de servicios: fechas de servicio y vencimiento obligatorias
    const concept = input.concept ?? 1;
    if (concept === 2 || concept === 3) {
      if (!input.serviceDateFrom || !input.serviceDateTo || !input.paymentDueDate) {
        throw new ValidationError(
          'Para facturación de servicios o productos y servicios, serviceDateFrom, serviceDateTo y paymentDueDate son obligatorios'
        );
      }
    }
  }

  public async validateAssociatedVouchersExistence(
    identity: FiscalIdentity,
    input: EmitInvoiceInput,
    userRole?: string
  ): Promise<void> {
    const isCredit = isCreditNote(input.voucherType);
    const isDebit = isDebitNote(input.voucherType);

    if (isCredit || isDebit) {
      if (!input.associatedVouchers || input.associatedVouchers.length === 0) {
        throw new ValidationError('Las Notas de Crédito y Débito exigen indicar al menos un comprobante asociado');
      }
    }

    if (!input.associatedVouchers || input.associatedVouchers.length === 0) {
      return;
    }

    const currentLetter = getVoucherLetter(input.voucherType);

    for (const assoc of input.associatedVouchers) {
      if (assoc.cuit !== undefined && !isValidCuit(assoc.cuit)) {
        throw new ValidationError(`El CUIT del comprobante asociado "${assoc.cuit}" no es válido`);
      }

      // R9: Normalizar CUIT propio y del comprobante asociado para evitar rechazos por guiones
      const isThirdParty = Boolean(assoc.cuit && cleanDocumentNumber(assoc.cuit) !== cleanDocumentNumber(identity.cuit));

      if (isThirdParty) {
        const normalizedRole = userRole?.toLowerCase();
        if (normalizedRole !== 'admin' && normalizedRole !== 'platform_admin') {
          throw new ForbiddenError(
            'La emisión de notas de crédito asociadas a comprobantes de otro CUIT requiere permisos de administrador'
          );
        }
        // R8: Alerta de auditoría para emisión de Notas de Crédito contra comprobantes de terceros
        logger.warn(
          { issuerCuit: identity.cuit, associatedCuit: assoc.cuit, userRole },
          'Emisión de Nota de Crédito asociada a comprobante de CUIT de terceros autorizada bajo rol administrador'
        );
        continue;
      }

      // Comprobante asociado de la misma identidad fiscal: exigir que exista localmente en AUTHORIZED
      const original = await this.invoiceRepo.findBySequenceNumber(
        identity.id,
        assoc.pointOfSale,
        assoc.voucherType,
        assoc.voucherNumber
      );

      if (!original || original.status !== 'AUTHORIZED') {
        throw new ValidationError(
          `El comprobante asociado tipo ${assoc.voucherType} ${assoc.pointOfSale}-${assoc.voucherNumber} no existe o no se encuentra en estado AUTHORIZED`
        );
      }

      // Validar coincidencia de clase (A/B/C)
      const originalLetter = getVoucherLetter(original.voucherType);
      if (currentLetter !== originalLetter) {
        throw new ValidationError(
          `La clase del comprobante asociado (${originalLetter}) no coincide con la clase del comprobante a emitir (${currentLetter})`
        );
      }

      // Si es Nota de Crédito:
      // El comprobante asociado DEBE ser Factura o Nota de Débito (NUNCA otra Nota de Crédito)
      if (isCredit) {
        if (isCreditNote(original.voucherType)) {
          throw new ValidationError(
            `No se permite emitir una Nota de Crédito sobre otra Nota de Crédito (comprobante ${assoc.pointOfSale}-${assoc.voucherNumber} tipo ${assoc.voucherType})`
          );
        }
        if (!isInvoice(original.voucherType) && !isDebitNote(original.voucherType)) {
          throw new ValidationError(
            `El comprobante asociado tipo ${assoc.voucherType} ${assoc.pointOfSale}-${assoc.voucherNumber} no es válido como origen de una Nota de Crédito. Debe ser una Factura o Nota de Débito.`
          );
        }
      }
    }
  }

  public async validateAssociatedVouchersBalance(
    identity: FiscalIdentity,
    input: EmitInvoiceInput,
    calcTotalAmount: number
  ): Promise<void> {
    if (!isCreditNote(input.voucherType) || !input.associatedVouchers || input.associatedVouchers.length === 0) {
      return;
    }

    for (const assoc of input.associatedVouchers) {
      const isThirdParty = Boolean(assoc.cuit && cleanDocumentNumber(assoc.cuit) !== cleanDocumentNumber(identity.cuit));
      if (isThirdParty) continue;

      const original = await this.invoiceRepo.findBySequenceNumber(
        identity.id,
        assoc.pointOfSale,
        assoc.voucherType,
        assoc.voucherNumber
      );
      if (!original) continue;

      const alreadyCredited = await this.invoiceRepo.getTotalCreditedForVoucher(
        identity.id,
        assoc.voucherType,
        assoc.pointOfSale,
        assoc.voucherNumber
      );

      const originalTotal = Number(original.totalAmount);
      const availableToCredit = Math.round((originalTotal - alreadyCredited + Number.EPSILON) * 100) / 100;

      if (calcTotalAmount > availableToCredit + 0.001) {
        throw new ValidationError(
          `El importe de la Nota de Crédito ($${calcTotalAmount.toFixed(2)}) supera el saldo disponible del comprobante asociado ($${Math.max(0, availableToCredit).toFixed(2)})`
        );
      }
    }
  }

  private async validateAssociatedVouchers(
    tenantId: string,
    identity: FiscalIdentity,
    input: EmitInvoiceInput,
    calcTotalAmount: number,
    userRole?: string
  ): Promise<void> {
    await this.validateAssociatedVouchersExistence(identity, input, userRole);
    await this.validateAssociatedVouchersBalance(identity, input, calcTotalAmount);
  }

  /**
   * M3: Conciliación automática en segundo plano de comprobantes en PENDING_RECONCILIATION
   */
  public async reconcileAllPending(): Promise<{ reconciled: number; failed: number }> {
    const db = getDatabase();
    // Margen mayor que la ventana en que ARCA puede procesar nuestra solicitud (OWN_PROCESSING_WINDOW_AFTER_MS):
    // conciliar antes podría dar "no registrado" (602) para un comprobante que ARCA todavía está procesando.
    const olderThan = new Date(Date.now() - 5 * 60_000);
    const pendingList = await db
      .select({ id: invoices.id, tenantId: invoices.tenantId })
      .from(invoices)
      .where(
        and(
          // PENDING viejos = emisiones cuyo proceso murió sin registrar el resultado
          inArray(invoices.status, UNRESOLVED_STATUSES),
          lte(invoices.createdAt, olderThan),
          lte(invoices.updatedAt, olderThan)
        )
      )
      // Los que fallaron recién (updatedAt actualizado abajo) van al final: no acaparan el lote
      .orderBy(asc(invoices.updatedAt))
      .limit(20);

    let reconciled = 0;
    let failed = 0;

    for (const item of pendingList) {
      try {
        await this.reconcileInvoice(item.tenantId, item.id);
        reconciled++;
      } catch (err) {
        failed++;
        logger.warn({ invoiceId: item.id, err }, 'Fallo en conciliación automática de comprobante pendiente');
        await db.update(invoices).set({ updatedAt: new Date() }).where(eq(invoices.id, item.id)).catch(() => {});
      }
    }

    return { reconciled, failed };
  }
}

