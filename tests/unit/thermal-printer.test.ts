import { describe, it, expect } from 'vitest';
import { ThermalPrinterService } from '../../src/modules/documents/application/thermal-printer-service.js';
import type { FullInvoice } from '../../src/modules/invoices/infrastructure/invoice-repository.js';
import type { FiscalIdentity } from '../../src/infrastructure/database/schema/fiscal-identities.js';

describe('ThermalPrinterService — Generación de Tickets Térmicos POS (80mm y 58mm)', () => {
  const mockIdentity: FiscalIdentity = {
    id: 'ident-001',
    tenantId: 'tenant-001',
    cuit: '20301234567',
    businessName: 'Ferretería El Tornillo',
    fantasyName: 'El Tornillo Central',
    environment: 'homologation',
    connectionType: 'DELEGATION',
    status: 'CONNECTED',
    statusReason: null,
    lastValidatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockInvoice: FullInvoice = {
    id: 'inv-001',
    tenantId: 'tenant-001',
    fiscalIdentityId: 'ident-001',
    pointOfSaleNumber: 1,
    voucherType: 6,
    voucherLetter: 'B',
    voucherNumber: 105,
    concept: 1,
    serviceDateFrom: null,
    serviceDateTo: null,
    paymentDueDate: null,
    issueDate: new Date(),
    status: 'AUTHORIZED',
    cae: '74123456789012',
    caeExpiresAt: new Date('2026-11-02T00:00:00Z'),
    totalAmount: '2500.00',
    netTaxedAmount: '2066.12',
    netUntaxedAmount: '0.00',
    exemptAmount: '0.00',
    vatAmount: '433.88',
    specialTaxesAmount: '0.00',
    currency: 'PES',
    currencyRate: '1.0000',
    customerId: null,
    customerDocType: 96,
    customerDocNumber: '35123456',
    customerName: 'Juan Pérez',
    customerTaxCondition: 5,
    customerAddress: 'Av. Corrientes 1234',
    notes: null,
    afipResult: 'A',
    afipXmlRequest: null,
    afipXmlResponse: null,
    afipErrors: null,
    afipObservations: null,
    afipEvents: null,
    idempotencyKey: null,
    posSaleId: 'pos-1234',
    qrData: 'https://www.afip.gob.ar/fe/qr/?p=sample',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: 'it-1',
        invoiceId: 'inv-001',
        productId: null,
        internalCode: 'CLAV-01',
        description: 'Caja Clavos 2 Pulgadas',
        quantity: '2.0000',
        unitPrice: '1250.0000',
        discount: '0.0000',
        vatRate: '21.00',
        vatAfipCode: 5,
        netSubtotal: '2066.12',
        vatSubtotal: '433.88',
        totalSubtotal: '2500.00',
        createdAt: new Date()
      }
    ],
    vatSubtotals: [],
    associatedVouchers: []
  };

  it('1. Formato Texto Plano 80mm', async () => {
    const result = await ThermalPrinterService.generate(mockInvoice, mockIdentity, {
      widthMm: 80,
      format: 'text'
    });

    expect(result.contentType).toBe('text/plain; charset=utf-8');
    expect(result.content).toContain('FERRETERÍA EL TORNILLO');
    expect(result.content).toContain('20-30123456-7');
    expect(result.content).toContain('Caja Clavos 2 Pulgadas');
    expect(result.content).toContain('$2500.00');
    expect(result.content).toContain('74123456789012');
    expect(result.content).toContain('Comprobante Autorizado por ARCA (AFIP)');
  });

  it('2. Formato HTML compacto con QR incrustado', async () => {
    const result = await ThermalPrinterService.generate(mockInvoice, mockIdentity, {
      widthMm: 80,
      format: 'html'
    });

    expect(result.contentType).toBe('text/html; charset=utf-8');
    expect(result.content).toContain('<html');
    expect(result.content).toContain('FERRETERÍA EL TORNILLO');
    expect(result.content).toContain('data:image/png;base64,');
    expect(result.content).toContain('74123456789012');
  });

  it('3. Marca de agua visible cuando es Borrador (DRAFT)', async () => {
    const draftInvoice: FullInvoice = {
      ...mockInvoice,
      status: 'DRAFT',
      voucherNumber: null,
      cae: null
    };

    const result = await ThermalPrinterService.generate(draftInvoice, mockIdentity, {
      widthMm: 80,
      format: 'text'
    });

    expect(result.content).toContain('*** DOCUMENTO NO VALIDO COMO FACTURA ***');
    expect(result.content).toContain('NO VALIDO COMO FACTURA');
  });
});
