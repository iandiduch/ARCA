import { XMLParser } from 'fast-xml-parser';
import { FiscalError, InfrastructureError } from '../../../../core/errors/app-error.js';
import { logger } from '../../../../app/logger.js';

export interface WsfeAuth {
  token: string;
  sign: string;
  cuit: string; // CUIT del emisor fiscal (11 dígitos)
}

export interface FeDummyResult {
  appServer: string;
  dbServer: string;
  authServer: string;
  isOk: boolean;
}

export interface WsfeClientOptions {
  environment?: 'homologation' | 'production' | undefined;
  timeoutMs?: number | undefined;
}

export class Wsfev1Client {
  private static readonly ENDPOINTS = {
    homologation: 'https://wswhomo.afip.gob.ar/wsfev1/service.asmx',
    production: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
  };

  /**
   * Ejecuta el método FEDummy para diagnosticar la disponibilidad de los servidores de ARCA
   */
  public static async dummy(options?: WsfeClientOptions): Promise<FeDummyResult> {
    const environment = options?.environment ?? 'homologation';
    const endpoint = this.ENDPOINTS[environment];

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FEDummy xmlns="http://ar.gov.afip.dif.FEV1/" />
  </soap:Body>
</soap:Envelope>`.trim();

    try {
      const xmlResponse = await this.executeSoap(
        endpoint,
        'http://ar.gov.afip.dif.FEV1/FEDummy',
        soapBody,
        options?.timeoutMs ?? 8000
      );

      const parser = new XMLParser();
      const parsed = parser.parse(xmlResponse);
      const result =
        parsed['soap:Envelope']?.['soap:Body']?.['FEDummyResponse']?.['FEDummyResult'] ||
        parsed['Envelope']?.['Body']?.['FEDummyResponse']?.['FEDummyResult'];

      if (!result) {
        throw new InfrastructureError('Respuesta inesperada en FEDummy de WSFEv1');
      }

      const appServer = String(result.AppServer ?? '');
      const dbServer = String(result.DbServer ?? '');
      const authServer = String(result.AuthServer ?? '');

      return {
        appServer,
        dbServer,
        authServer,
        isOk: appServer === 'OK' && dbServer === 'OK' && authServer === 'OK'
      };
    } catch (err) {
      logger.warn({ err }, 'Error al consultar FEDummy');
      throw err;
    }
  }

  /**
   * Consulta el último número de comprobante autorizado para un punto de venta y tipo
   */
  public static async getUltimoComprobante(
    auth: WsfeAuth,
    ptoVta: number,
    cbteTipo: number,
    options?: WsfeClientOptions
  ): Promise<number> {
    const environment = options?.environment ?? 'homologation';
    const endpoint = this.ENDPOINTS[environment];

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fev="http://ar.gov.afip.dif.FEV1/">
  <soap:Body>
    <fev:FECompUltimoAutorizado>
      <fev:Auth>
        <fev:Token>${auth.token}</fev:Token>
        <fev:Sign>${auth.sign}</fev:Sign>
        <fev:Cuit>${auth.cuit}</fev:Cuit>
      </fev:Auth>
      <fev:PtoVta>${ptoVta}</fev:PtoVta>
      <fev:CbteTipo>${cbteTipo}</fev:CbteTipo>
    </fev:FECompUltimoAutorizado>
  </soap:Body>
</soap:Envelope>`.trim();

    const xmlResponse = await this.executeSoap(
      endpoint,
      'http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado',
      soapBody,
      options?.timeoutMs ?? 15000
    );

    const parser = new XMLParser({ isArray: (name) => name === 'Err' });
    const parsed = parser.parse(xmlResponse);
    const result =
      parsed['soap:Envelope']?.['soap:Body']?.['FECompUltimoAutorizadoResponse']?.['FECompUltimoAutorizadoResult'] ||
      parsed['Envelope']?.['Body']?.['FECompUltimoAutorizadoResponse']?.['FECompUltimoAutorizadoResult'];

    if (!result) {
      throw new InfrastructureError('Respuesta inesperada en FECompUltimoAutorizado');
    }

    if (result.Errors?.Err?.length) {
      const errs = result.Errors.Err.map((e: { Code?: number; Msg?: string }) => ({
        code: e.Code ?? 0,
        message: e.Msg ?? 'Error ARCA'
      }));
      throw new FiscalError(
        `Error al consultar último comprobante: ${errs.map((e: { code: number; message: string }) => `[${e.code}] ${e.message}`).join(', ')}`,
        errs
      );
    }

    return Number(result.CbteNro ?? 0);
  }

  /**
   * Consulta los puntos de venta habilitados para el emisor
   */
  public static async getPuntosVenta(
    auth: WsfeAuth,
    options?: WsfeClientOptions
  ): Promise<Array<{ nro: number; emisionTipo: string; bloqueado: boolean; fchBaja?: string }>> {
    const environment = options?.environment ?? 'homologation';
    const endpoint = this.ENDPOINTS[environment];

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fev="http://ar.gov.afip.dif.FEV1/">
  <soap:Body>
    <fev:FEParamGetPtosVenta>
      <fev:Auth>
        <fev:Token>${auth.token}</fev:Token>
        <fev:Sign>${auth.sign}</fev:Sign>
        <fev:Cuit>${auth.cuit}</fev:Cuit>
      </fev:Auth>
    </fev:FEParamGetPtosVenta>
  </soap:Body>
</soap:Envelope>`.trim();

    const xmlResponse = await this.executeSoap(
      endpoint,
      'http://ar.gov.afip.dif.FEV1/FEParamGetPtosVenta',
      soapBody,
      options?.timeoutMs ?? 15000
    );

    const parser = new XMLParser({ isArray: (name) => name === 'PtoVenta' || name === 'Err' });
    const parsed = parser.parse(xmlResponse);
    const result =
      parsed['soap:Envelope']?.['soap:Body']?.['FEParamGetPtosVentaResponse']?.['FEParamGetPtosVentaResult'] ||
      parsed['Envelope']?.['Body']?.['FEParamGetPtosVentaResponse']?.['FEParamGetPtosVentaResult'];

    if (!result) {
      throw new InfrastructureError('Respuesta inesperada en FEParamGetPtosVenta');
    }

    if (result.Errors?.Err?.length) {
      const errs = result.Errors.Err.map((e: { Code?: number; Msg?: string }) => ({
        code: e.Code ?? 0,
        message: e.Msg ?? 'Error ARCA'
      }));
      throw new FiscalError(
        `Error al consultar puntos de venta: ${errs.map((e: { code: number; message: string }) => `[${e.code}] ${e.message}`).join(', ')}`,
        errs
      );
    }

    const items = result.ResultGet?.PtoVenta ?? [];
    return items.map((p: { Nro?: number; EmisionTipo?: string; Bloqueado?: string; FchBaja?: string }) => ({
      nro: Number(p.Nro ?? 0),
      emisionTipo: String(p.EmisionTipo ?? ''),
      bloqueado: String(p.Bloqueado ?? '').toUpperCase() === 'S',
      fchBaja: p.FchBaja ? String(p.FchBaja) : undefined
    }));
  }

  private static async executeSoap(url: string, soapAction: string, body: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: soapAction
        },
        body,
        signal: controller.signal
      });

      const responseText = await res.text();

      if (!res.ok && !responseText.includes('<soap:Fault>') && !responseText.includes('<faultstring>')) {
        throw new InfrastructureError(`WSFEv1 respondió con HTTP ${res.status}: ${res.statusText}`);
      }

      return responseText;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new InfrastructureError(`Timeout al conectar con WSFEv1 (${timeoutMs}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
