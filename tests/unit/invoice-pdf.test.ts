import { describe, it, expect } from 'vitest';
import { InvoicePdfService } from '../../src/modules/documents/application/invoice-pdf-service.js';
import type { FullInvoice } from '../../src/modules/invoices/infrastructure/invoice-repository.js';
import type { FiscalIdentity } from '../../src/infrastructure/database/schema/fiscal-identities.js';

describe('InvoicePdfService — Generación de Facturas PDF Reglamentarias ARCA', () => {
  const mockIdentity: FiscalIdentity = {
    id: 'ident-002',
    tenantId: 'tenant-002',
    cuit: '20301234567',
    businessName: 'Distribuidora Argentina S.A.',
    fantasyName: 'Distribuidora Central',
    environment: 'homologation',
    connectionType: 'DELEGATION',
    status: 'CONNECTED',
    statusReason: null,
    lastValidatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockInvoice: FullInvoice = {
    id: 'inv-pdf-001',
    tenantId: 'tenant-002',
    fiscalIdentityId: 'ident-002',
    pointOfSaleNumber: 2,
    voucherType: 1, // Factura A
    voucherLetter: 'A',
    voucherNumber: 42,
    concept: 1,
    serviceDateFrom: null,
    serviceDateTo: null,
    paymentDueDate: null,
    issueDate: new Date(),
    status: 'AUTHORIZED',
    cae: '74123456789012',
    caeExpiresAt: new Date('2026-11-02T00:00:00Z'),
    totalAmount: '12100.00',
    netTaxedAmount: '10000.00',
    netUntaxedAmount: '0.00',
    exemptAmount: '0.00',
    vatAmount: '2100.00',
    specialTaxesAmount: '0.00',
    currency: 'PES',
    currencyRate: '1.0000',
    customerId: null,
    customerDocType: 80,
    customerDocNumber: '30712345678',
    customerName: 'Cliente Mayorista S.R.L.',
    customerTaxCondition: 1,
    customerAddress: 'Calle Falsa 123',
    notes: 'Entrega en depósito',
    afipResult: 'A',
    afipXmlRequest: null,
    afipXmlResponse: null,
    afipErrors: null,
    afipObservations: null,
    afipEvents: null,
    idempotencyKey: null,
    posSaleId: 'pos-99',
    qrData: 'https://www.afip.gob.ar/fe/qr/?p=eyJ2ZXIiOjF9',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: 'it-pdf-1',
        invoiceId: 'inv-pdf-001',
        productId: null,
        internalCode: 'PROD-A',
        description: 'Bulto Mercadería General',
        quantity: '10.0000',
        unitPrice: '1000.0000',
        discount: '0.0000',
        vatRate: '21.00',
        vatAfipCode: 5,
        netSubtotal: '10000.00',
        vatSubtotal: '2100.00',
        totalSubtotal: '12100.00',
        createdAt: new Date()
      }
    ],
    vatSubtotals: [
      {
        id: 'vat-sub-1',
        invoiceId: 'inv-pdf-001',
        vatAfipCode: 5,
        vatRate: '21.00',
        baseAmount: '10000.00',
        vatAmount: '2100.00',
        createdAt: new Date()
      }
    ],
    associatedVouchers: []
  };

  it('1. Debe generar un buffer binario PDF válido (encabezado %PDF-)', async () => {
    const pdfBuffer = await InvoicePdfService.generatePdf(mockInvoice, mockIdentity);

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(1000);

    // Firma de archivo PDF: %PDF- (0x25 0x50 0x44 0x46 0x2D)
    const headerStr = pdfBuffer.slice(0, 5).toString('ascii');
    expect(headerStr).toBe('%PDF-');
  });

  it('2. Debe generar PDF para Borrador sin lanzar errores', async () => {
    const draftInvoice: FullInvoice = {
      ...mockInvoice,
      status: 'DRAFT',
      voucherNumber: null,
      cae: null
    };

    const pdfBuffer = await InvoicePdfService.generatePdf(draftInvoice, mockIdentity);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('3. Debe generar PDF en entorno de producción sin errores', async () => {
    const prodIdentity: FiscalIdentity = {
      ...mockIdentity,
      environment: 'production',
      taxCondition: 'RESPONSABLE_INSCRIPTO',
      grossIncomeNumber: '30-71234567-8',
      activityStartDate: '01/03/2015'
    };

    const pdfBuffer = await InvoicePdfService.generatePdf(mockInvoice, prodIdentity);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
