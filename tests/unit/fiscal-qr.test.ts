import { describe, it, expect } from 'vitest';
import { FiscalQrGenerator } from '../../src/modules/invoices/domain/qr-generator.js';

describe('FiscalQrGenerator — Generador de QR Fiscal RG 5003/2021', () => {
  it('Debe generar una URL con el esquema oficial de AFIP y payload decodificable en Base64', () => {
    const url = FiscalQrGenerator.buildQrUrl({
      ver: 1,
      fecha: '2026-10-23',
      cuit: 20301234567,
      ptoVta: 1,
      tipoCmp: 6,
      nroCmp: 104,
      importe: 2315.5,
      moneda: 'PES',
      ctz: 1,
      tipoDocRec: 99,
      nroDocRec: 0,
      tipoCodAut: 'E',
      codAut: 74123456789012
    });

    expect(url).toContain('https://www.afip.gob.ar/fe/qr/?p=');

    const base64Part = url.replace('https://www.afip.gob.ar/fe/qr/?p=', '');
    const decodedJson = JSON.parse(Buffer.from(base64Part, 'base64').toString('utf-8'));

    expect(decodedJson.ver).toBe(1);
    expect(decodedJson.fecha).toBe('2026-10-23');
    expect(decodedJson.cuit).toBe(20301234567);
    expect(decodedJson.ptoVta).toBe(1);
    expect(decodedJson.tipoCmp).toBe(6);
    expect(decodedJson.nroCmp).toBe(104);
    expect(decodedJson.importe).toBe(2315.5);
    expect(decodedJson.tipoCodAut).toBe('E');
    expect(decodedJson.codAut).toBe(74123456789012);
  });
});
