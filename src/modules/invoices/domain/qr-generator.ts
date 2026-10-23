export interface FiscalQrPayload {
  ver: number; // 1
  fecha: string; // YYYY-MM-DD
  cuit: number; // CUIT emisor
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: number;
  moneda: string; // 'PES'
  ctz: number; // 1
  tipoDocRec?: number | undefined;
  nroDocRec?: number | undefined;
  tipoCodAut: 'E'; // 'E' = CAE
  codAut: number; // Número de CAE
}

export class FiscalQrGenerator {
  public static buildQrUrl(payload: FiscalQrPayload): string {
    const jsonStr = JSON.stringify(payload);
    const base64 = Buffer.from(jsonStr, 'utf-8').toString('base64');
    return `https://www.afip.gob.ar/fe/qr/?p=${base64}`;
  }
}
