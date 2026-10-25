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
import {
  getVoucherLetter,
  isCreditNote,
  isDebitNote,
  requiresVatBreakdown
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
        serviceDateFrom: input.serviceDateFrom ? new Date(input.serviceDateFrom) : undefined,
        serviceDateTo: input.serviceDateTo ? new Date(input.serviceDateTo) : undefined,
        paymentDueDate: input.paymentDueDate ? new Date(input.paymentDueDate) : undefined,
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
      let idemp = await IdempotencyService.acquire(tenantId, input.idempotencyKey, 'invoices');
      if (idemp.state === 'IN_PROGRESS') {
        idemp = await IdempotencyService.waitForCompletion(tenantId, input.idempotencyKey);
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

    try {
      const result = await FiscalLock.withLock(
        input.fiscalIdentityId,
        input.pointOfSaleNumber,
        input.voucherType,
        () => this.executeFiscalEmission(tenantId, input, userId)
      );

      if (input.idempotencyKey) {
        await IdempotencyService.complete(tenantId, input.idempotencyKey, 201, result);
      }

      return result;
    } catch (err) {
      if (input.idempotencyKey && !(err instanceof InfrastructureError && err.message.includes('PENDING_RECONCILIATION'))) {
        await IdempotencyService.release(tenantId, input.idempotencyKey);
      }
      throw err;
    }
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
    const identity = await this.fiscalRepo.findById(tenantId, input.fiscalIdentityId);
    if (!identity) {
      throw new NotFoundError(`Identidad fiscal con ID "${input.fiscalIdentityId}" no encontrada`);
    }

    const cert = await this.fiscalRepo.getActiveCertificate(identity.id);
    if (!cert || !cert.certificate) {
      throw new ValidationError(
        `La identidad fiscal ${identity.cuit} no posee un certificado X.509 activo emitido por ARCA`
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
    const privateKeyPem = EncryptionService.decrypt({
      ciphertext: cert.encryptedPrivateKey,
      iv: cert.privateKeyIv,
      authTag: cert.privateKeyAuthTag
    });

    const wsaaCreds = await WsaaClient.getTicket(
      identity.id,
      privateKeyPem,
      cert.certificate,
      {
        environment: identity.environment as 'homologation' | 'production',
        service: 'wsfe'
      }
    );

    const wsfeAuth = {
      token: wsaaCreds.token,
      sign: wsaaCreds.sign,
      cuit: identity.cuit
    };

    // F. Obtener próximo número de comprobante desde ARCA
    const lastNumber = await Wsfev1Client.getUltimoComprobante(
      wsfeAuth,
      input.pointOfSaleNumber,
      input.voucherType,
      { environment: identity.environment as 'homologation' | 'production' }
    );
    const nextVoucherNumber = lastNumber + 1;

    // G. Crear el registro preliminar en base de datos con status PENDING
    const draftInvoice = await this.invoiceRepo.createWithDetails(
      {
        tenantId,
        fiscalIdentityId: identity.id,
        pointOfSaleNumber: input.pointOfSaleNumber,
        voucherType: input.voucherType,
        voucherLetter,
        voucherNumber: nextVoucherNumber,
        concept,
        serviceDateFrom: input.serviceDateFrom ? new Date(input.serviceDateFrom) : undefined,
        serviceDateTo: input.serviceDateTo ? new Date(input.serviceDateTo) : undefined,
        paymentDueDate: input.paymentDueDate ? new Date(input.paymentDueDate) : undefined,
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

    // H. Formatear fechas para ARCA (YYYYMMDD)
    const now = new Date();
    const cbteFch = this.formatDateYyyyMmDd(now);
    const fchServDesde = input.serviceDateFrom ? this.formatDateYyyyMmDd(new Date(input.serviceDateFrom)) : undefined;
    const fchServHasta = input.serviceDateTo ? this.formatDateYyyyMmDd(new Date(input.serviceDateTo)) : undefined;
    const fchVtoPago = input.paymentDueDate ? this.formatDateYyyyMmDd(new Date(input.paymentDueDate)) : undefined;

    // I. Solicitar autorización fiscal (CAE) a WSFEv1
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
        { environment: identity.environment as 'homologation' | 'production' }
      );
    } catch (err: unknown) {
      // Manejo de corte de conexión o timeout durante la emisión: NO reintentar a ciegas.
      // Marcamos el comprobante como PENDING_RECONCILIATION para que sea conciliado sin duplicar numeración.
      await this.invoiceRepo.update(tenantId, draftInvoice.id, {
        status: 'PENDING_RECONCILIATION',
        notes: `Interrupción en la comunicación con ARCA: ${err instanceof Error ? err.message : String(err)}`
      });

      logger.warn(
        { invoiceId: draftInvoice.id, err },
        'Interrupción de red durante FECAESolicitar. Comprobante guardado como PENDING_RECONCILIATION'
      );

      throw new InfrastructureError(
        'Se produjo un timeout o error de comunicación con ARCA. El comprobante fue registrado con estado PENDING_RECONCILIATION para su verificación automática.'
      );
    }

    // J. Procesar resultado de ARCA
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
   * Reconcilia un comprobante que quedó en PENDING_RECONCILIATION consultando FECompConsultar en ARCA
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

    if (invoice.status !== 'PENDING_RECONCILIATION') {
      throw new ValidationError(
        `El comprobante se encuentra en estado "${invoice.status}", solo los comprobantes en "PENDING_RECONCILIATION" pueden ser conciliados`
      );
    }

    const identity = await this.fiscalRepo.findById(tenantId, invoice.fiscalIdentityId);
    if (!identity) {
      throw new NotFoundError('Identidad fiscal asociada no encontrada');
    }

    const cert = await this.fiscalRepo.getActiveCertificate(identity.id);
    if (!cert || !cert.certificate) {
      throw new ValidationError('Certificado fiscal no encontrado');
    }

    const privateKeyPem = EncryptionService.decrypt({
      ciphertext: cert.encryptedPrivateKey,
      iv: cert.privateKeyIv,
      authTag: cert.privateKeyAuthTag
    });

    const wsaaCreds = await WsaaClient.getTicket(
      identity.id,
      privateKeyPem,
      cert.certificate,
      {
        environment: identity.environment as 'homologation' | 'production',
        service: 'wsfe'
      }
    );

    const wsfeAuth = {
      token: wsaaCreds.token,
      sign: wsaaCreds.sign,
      cuit: identity.cuit
    };

    const consult = await Wsfev1Client.consultarComprobante(
      wsfeAuth,
      invoice.pointOfSaleNumber,
      invoice.voucherType,
      invoice.voucherNumber!,
      { environment: identity.environment as 'homologation' | 'production' }
    );

    if (consult.encontrado && consult.cae) {
      // El comprobante efectivamente fue procesado y autorizado por ARCA
      const caeExpiresAt = consult.caeFchVto ? this.parseAfipDate(consult.caeFchVto) : undefined;
      const qrData = FiscalQrGenerator.buildQrUrl({
        ver: 1,
        fecha: this.formatDateIso(new Date()),
        cuit: Number(identity.cuit),
        ptoVta: invoice.pointOfSaleNumber,
        tipoCmp: invoice.voucherType,
        nroCmp: invoice.voucherNumber!,
        importe: Number(invoice.totalAmount),
        moneda: invoice.currency,
        ctz: Number(invoice.currencyRate),
        tipoDocRec: invoice.customerDocType,
        nroDocRec: Number(invoice.customerDocNumber) || 0,
        tipoCodAut: 'E',
        codAut: Number(consult.cae)
      });

      await this.invoiceRepo.update(tenantId, invoice.id, {
        status: 'AUTHORIZED',
        cae: consult.cae,
        caeExpiresAt,
        afipResult: 'A',
        afipObservations: consult.observaciones,
        qrData
      });

      await AuditService.record({
        tenantId,
        userId,
        action: 'INVOICE_RECONCILED_AUTHORIZED',
        entityType: 'invoice',
        entityId: invoice.id
      });
    } else {
      // No existe en ARCA: la solicitud nunca llegó a impactar
      await this.invoiceRepo.update(tenantId, invoice.id, {
        status: 'CANCELLED',
        notes: 'Comprobante no registrado en ARCA tras consulta de reconciliación'
      });

      await AuditService.record({
        tenantId,
        userId,
        action: 'INVOICE_RECONCILED_NOT_FOUND',
        entityType: 'invoice',
        entityId: invoice.id
      });
    }

    const updated = await this.invoiceRepo.findById(tenantId, invoice.id);
    return updated!;
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

