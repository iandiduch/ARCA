import { InvoiceRepository, type FullInvoice, type InvoiceListFilters } from '../infrastructure/invoice-repository.js';
import { FiscalIdentityRepository } from '../../fiscal-identities/infrastructure/fiscal-identity-repository.js';
import { TaxCalculator, type InvoiceItemInput } from '../domain/tax-calculator.js';
import { FiscalQrGenerator } from '../domain/qr-generator.js';
import { WsaaClient } from '../../arca/infrastructure/wsaa/wsaa-client.js';
import { Wsfev1Client } from '../../arca/infrastructure/wsfev1/wsfev1-client.js';
import { EncryptionService } from '../../../core/security/encryption.js';
import { IdempotencyService } from '../../../core/security/idempotency-service.js';
import { AuditService } from '../../audit/application/audit-service.js';
import { FiscalLock } from '../../../core/security/fiscal-lock.js';
import { isValidCuit } from '../../../core/fiscal/cuit-validator.js';
import { isValidIsoDate, isoDateToAfip, isoDateToArgentinaNoon } from '../../../core/fiscal/fiscal-dates.js';
import type { Invoice } from '../../../infrastructure/database/schema/invoices.js';
import type { FiscalIdentity } from '../../../infrastructure/database/schema/fiscal-identities.js';
import type { FiscalCertificate } from '../../../infrastructure/database/schema/fiscal-certificates.js';
import type { WsfeAuth } from '../../arca/infrastructure/wsfev1/wsfev1-client.js';
import {
  getVoucherLetter,
  isCreditNote,
  isDebitNote,
  requiresVatBreakdown,
  resolveItemVat,
  SUPPORTED_VOUCHER_TYPES
} from '../../../core/fiscal/tax-catalogs.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  FiscalError,
  InfrastructureError
} from '../../../core/errors/app-error.js';
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

/** Estados con numeración asignada cuyo resultado en ARCA todavía no se conoce */
const UNRESOLVED_STATUSES = ['PENDING', 'PENDING_RECONCILIATION'];

type ArcaEnvironment = 'homologation' | 'production';

export class InvoiceService {
  private invoiceRepo = new InvoiceRepository();
  private fiscalRepo = new FiscalIdentityRepository();

  /**
   * Crea un comprobante en estado borrador (DRAFT) sin consultar ARCA ni asignar numeración oficial
   */
  public async createDraft(
    tenantId: string,
    input: EmitInvoiceInput,
    userId?: string
  ): Promise<FullInvoice> {
    const identity = await this.fiscalRepo.findById(tenantId, input.fiscalIdentityId);
    if (!identity) {
      throw new NotFoundError(`Identidad fiscal con ID "${input.fiscalIdentityId}" no encontrada`);
    }

    this.validateFiscalRules(input);

    const voucherLetter = getVoucherLetter(input.voucherType);
    const pricesIncludeVat = input.pricesIncludeVat !== false;
    const calc = TaxCalculator.calculate(input.items, input.voucherType, pricesIncludeVat);

    const docType = input.customer?.docType ?? 99;
    const docNumber = input.customer?.docNumber ?? (docType === 99 ? '0' : '');
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
        customerTaxCondition: input.customer?.taxCondition ?? (docType === 99 ? 5 : undefined),
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
    userId?: string
  ): Promise<FullInvoice> {
    // 1. Control estricto de Idempotencia si el cliente envió idempotencyKey
    if (input.idempotencyKey) {
      const idempOptions = { requestHash: IdempotencyService.hashPayload(this.fingerprint(input)) };
      let idemp = await IdempotencyService.acquire(tenantId, input.idempotencyKey, 'invoices', idempOptions);
      if (idemp.state === 'IN_PROGRESS') {
        // Reintento del POS tras una emisión interrumpida: conciliar primero con ARCA.
        // Si ARCA la autorizó se devuelve esa factura; si nunca llegó, la clave se libera y se emite de nuevo.
        const interrupted = await this.invoiceRepo.findLatestByIdempotencyKey(tenantId, input.idempotencyKey);
        if (interrupted?.status === 'AUTHORIZED') {
          return this.getInvoiceById(tenantId, interrupted.id);
        }
        if (interrupted?.status === 'PENDING_RECONCILIATION') {
          const resolved = await this.reconcileInvoice(tenantId, interrupted.id, userId);
          if (resolved.status === 'AUTHORIZED') {
            return resolved;
          }
          idemp = await IdempotencyService.acquire(tenantId, input.idempotencyKey, 'invoices', idempOptions);
        }
      }
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

    let result: FullInvoice;
    try {
      result = await FiscalLock.withLock(
        input.fiscalIdentityId,
        input.pointOfSaleNumber,
        input.voucherType,
        () => this.executeFiscalEmission(tenantId, input, userId)
      );
    } catch (err) {
      if (input.idempotencyKey && !(err instanceof InfrastructureError && err.code === PENDING_RECONCILIATION_CODE)) {
        await IdempotencyService.release(tenantId, input.idempotencyKey);
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
  }

  /**
   * Flujo nuclear de validación fiscal, obtención de ticket WSAA y solicitud de CAE ante WSFEv1
   */
  private async executeFiscalEmission(
    tenantId: string,
    input: EmitInvoiceInput,
    userId?: string
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

    // B. Validar punto de venta
    const ptos = await this.fiscalRepo.getPointsOfSale(identity.id);
    const ptoRecord = ptos.find((p) => p.number === input.pointOfSaleNumber);
    if (!ptoRecord) {
      throw new ValidationError(
        `El punto de venta ${input.pointOfSaleNumber} no está configurado para la identidad fiscal ${identity.cuit}`
      );
    }

    // C. Validaciones fiscales según normativa ARCA
    this.validateFiscalRules(input);

    const docType = input.customer?.docType ?? 99;
    const docNumber = input.customer?.docNumber ? input.customer.docNumber.trim() : (docType === 99 ? '0' : '');
    const customerName = input.customer?.name ?? (docType === 99 ? 'Consumidor Final' : 'Cliente');
    const voucherLetter = getVoucherLetter(input.voucherType);
    const concept = input.concept ?? 1;

    // D. Motor de cálculo impositivo

    const pricesIncludeVat = input.pricesIncludeVat !== false;
    const calc = TaxCalculator.calculate(input.items, input.voucherType, pricesIncludeVat);

    // E. Desencriptar clave privada y obtener credenciales WSAA
    const wsfeAuth = await this.getWsfeAuth(identity, cert);

    // F. Conciliar emisiones previas interrumpidas de esta secuencia. Estamos dentro del FiscalLock,
    // por lo que ningún comprobante PENDING de esta secuencia puede estar realmente en curso.
    await this.resolveStaleInSequence(identity, wsfeAuth, input.pointOfSaleNumber, input.voucherType, userId);

    // G. Obtener próximo número de comprobante desde ARCA
    const lastNumber = await Wsfev1Client.getUltimoComprobante(
      wsfeAuth,
      input.pointOfSaleNumber,
      input.voucherType,
      { environment }
    );
    const nextVoucherNumber = lastNumber + 1;

    const clash = await this.invoiceRepo.findBySequenceNumber(
      identity.id,
      input.pointOfSaleNumber,
      input.voucherType,
      nextVoucherNumber
    );
    if (clash) {
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
        customerTaxCondition: input.customer?.taxCondition ?? (docType === 99 ? 5 : undefined),
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
    let caeResponse;
    try {
      caeResponse = await Wsfev1Client.solicitarCae(
        wsfeAuth,
        {
          ptoVta: input.pointOfSaleNumber,
          cbteTipo: input.voucherType,
          detalle: {
            concepto: concept,
            docTipo: docType,
            docNro: docNumber || 0,
            cbteDesde: nextVoucherNumber,
            cbteHasta: nextVoucherNumber,
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
            condicionIvaReceptorId: draftInvoice.customerTaxCondition ?? (voucherLetter === 'A' ? 1 : 5),
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
      // Manejo de corte de conexión o timeout durante la emisión: NO reintentar a ciegas.
      // Marcamos el comprobante como PENDING_RECONCILIATION para que sea conciliado sin duplicar numeración.
      // Si este update también falla, el registro queda en PENDING y se concilia en la próxima emisión de la secuencia.
      await this.invoiceRepo
        .update(tenantId, draftInvoice.id, {
          status: 'PENDING_RECONCILIATION',
          notes: `Interrupción en la comunicación con ARCA: ${err instanceof Error ? err.message : String(err)}`
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

    // K. Procesar resultado de ARCA
    if (caeResponse.resultado === 'A') {
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

      const updated = await this.invoiceRepo.findById(tenantId, draftInvoice.id);
      return updated!;
    } else {
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

    return FiscalLock.withLock(identity.id, invoice.pointOfSaleNumber, invoice.voucherType, async () => {
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
  ): Promise<void> {
    const stale = await this.invoiceRepo.findUnresolvedInSequence(identity.id, pointOfSaleNumber, voucherType);
    for (const inv of stale) {
      try {
        await this.resolveAgainstArca(inv, identity, wsfeAuth, userId);
      } catch (err) {
        // Si no se puede determinar el estado, el control de colisión de numeración evita duplicar el número
        logger.warn({ err, invoiceId: inv.id }, 'No se pudo conciliar automáticamente un comprobante pendiente');
      }
    }
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
      notes: `Comprobante no registrado en ARCA tras consulta de reconciliación (número ${voucherNumber} liberado)`
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

  private parseAfipDate(dateStr: string): Date {
    // Format YYYYMMDD
    const y = parseInt(dateStr.substring(0, 4), 10);
    const m = parseInt(dateStr.substring(4, 6), 10) - 1;
    const d = parseInt(dateStr.substring(6, 8), 10);
    return new Date(Date.UTC(y, m, d, 23, 59, 59));
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
    const docNumber = input.customer?.docNumber ? input.customer.docNumber.trim() : (docType === 99 ? '0' : '');

    // Validación Factura A / NC A / ND A: receptor obligatorio con CUIT válido
    const voucherLetter = getVoucherLetter(input.voucherType);
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
}

