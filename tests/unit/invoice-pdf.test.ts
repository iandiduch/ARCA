import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { InvoicePdfService } from '../../src/modules/documents/application/invoice-pdf-service.js';
import type { FullInvoice } from '../../src/modules/invoices/infrastructure/invoice-repository.js';
import type { FiscalIdentity } from '../../src/infrastructure/database/schema/fiscal-identities.js';

/**
 * Extrae el texto visible de un PDF generado con pdfkit. Los streams vienen comprimidos
 * (FlateDecode) y el texto se escribe como hex dentro de arrays `[<...> ...] TJ` con la
 * codificación WinAnsi de las fuentes estándar (compatible con latin1 para los acentos).
 */
function pdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const lines: string[] = [];
  let offset = 0;

  while (offset < raw.length) {
    const start = raw.indexOf('stream', offset);
    if (start === -1) break;

    let dataStart = start + 'stream'.length;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;
    const end = raw.indexOf('endstream', dataStart);
    if (end === -1) break;
    offset = end + 'endstream'.length;

    let content: string;
    try {
      content = inflateSync(buffer.subarray(dataStart, end)).toString('latin1');
    } catch {
      // Streams que no son de contenido de texto (por ejemplo, la imagen PNG del QR)
      continue;
    }

    const tjRegex = /\[((?:\s*(?:<[0-9a-fA-F]*>|-?\d+(?:\.\d+)?))*)\s*\]\s*TJ/g;
    let match: RegExpExecArray | null;
    while ((match = tjRegex.exec(content)) !== null) {
      const hexParts = match[1]!.match(/<([0-9a-fA-F]*)>/g) ?? [];
      const line = hexParts.map((part) => Buffer.from(part.slice(1, -1), 'hex').toString('latin1')).join('');
      if (line.length > 0) lines.push(line);
    }
  }

  return lines.join('\n');
}

describe('InvoicePdfService — Generación de Facturas PDF Reglamentarias ARCA', () => {
  const mockIdentity: FiscalIdentity = {
    id: 'ident-002',
    tenantId: 'tenant-002',
    cuit: '20301234567',
    businessName: 'Distribuidora Argentina S.A.',
    fantasyName: 'Distribuidora Central',
    commercialAddress: 'Av. Corrientes 456',
    environment: 'homologation',
    taxCondition: 'IVA_RESPONSABLE_INSCRIPTO',
    grossIncomeNumber: null,
    activityStartDate: null,
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

  it('4. El membrete del punto de venta pisa al de la identidad', async () => {
    const pdfBuffer = await InvoicePdfService.generatePdf(mockInvoice, mockIdentity, {
      fantasyName: 'Ferretería',
      commercialAddress: 'Av. San Martín 1234, Taco Pozo'
    });
    const text = pdfText(pdfBuffer);

    expect(text).toContain('FERRETERÍA');
    expect(text).toContain('Domicilio Comercial: Av. San Martín 1234, Taco Pozo');
    expect(text).not.toContain('DISTRIBUIDORA CENTRAL');
    expect(text).not.toContain('Av. Corrientes 456');
  });

  it('5. Sin punto de venta usa el membrete de la identidad', async () => {
    const text = pdfText(await InvoicePdfService.generatePdf(mockInvoice, mockIdentity));

    expect(text).toContain('DISTRIBUIDORA CENTRAL');
    expect(text).toContain('Domicilio Comercial: Av. Corrientes 456');
  });

  it('6. Sin domicilio, IIBB ni inicio de actividades no imprime esas líneas ni datos inventados', async () => {
    const identity: FiscalIdentity = {
      ...mockIdentity,
      fantasyName: null,
      businessName: 'Comercio Sin Datos',
      commercialAddress: null,
      taxCondition: 'RESPONSABLE_MONOTRIBUTO',
      grossIncomeNumber: null,
      activityStartDate: null
    };
    const invoiceWithoutAddress: FullInvoice = { ...mockInvoice, customerAddress: null };

    const text = pdfText(await InvoicePdfService.generatePdf(invoiceWithoutAddress, identity));

    expect(text).toContain('COMERCIO SIN DATOS');
    expect(text).not.toContain('Domicilio Comercial:');
    expect(text).not.toContain('Ingresos Brutos:');
    expect(text).not.toContain('Inicio de Actividades:');
    expect(text).not.toContain('Casa Central');
    expect(text).not.toContain('01/01/2020');
    expect(text).not.toContain('Ciudad Autónoma de Buenos Aires');
    expect(text).not.toContain('Domicilio:');
  });

  it('7. Con IIBB e inicio de actividades los imprime con el formato correcto', async () => {
    const identity: FiscalIdentity = {
      ...mockIdentity,
      grossIncomeNumber: '901-234567-8',
      activityStartDate: '2019-03-15'
    };

    const text = pdfText(await InvoicePdfService.generatePdf(mockInvoice, identity));

    expect(text).toContain('Ingresos Brutos: 901-234567-8');
    expect(text).toContain('Inicio de Actividades: 15/03/2019');
    expect(text).not.toContain('01/01/2020');
  });

  it('8. Imprime la condición frente al IVA con su etiqueta canónica', async () => {
    const cases: Array<[string, string]> = [
      ['IVA_RESPONSABLE_INSCRIPTO', 'Condición frente al IVA: IVA Responsable Inscripto'],
      ['responsable_inscripto', 'Condición frente al IVA: IVA Responsable Inscripto'],
      ['monotributo', 'Condición frente al IVA: Responsable Monotributo']
    ];

    for (const [taxCondition, expected] of cases) {
      const identity: FiscalIdentity = { ...mockIdentity, taxCondition };
      const text = pdfText(await InvoicePdfService.generatePdf(mockInvoice, identity));
      expect(text).toContain(expected);
    }
  });
});
