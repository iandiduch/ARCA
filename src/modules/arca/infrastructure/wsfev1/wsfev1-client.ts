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
        options?.timeoutMs ?? 25000
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
      // Código 602 de ARCA: "Sin Resultados" (el contribuyente no tiene puntos de venta creados en el ambiente)
      const isOnlySinResultados = result.Errors.Err.every((e: { Code?: number }) => Number(e.Code) === 602);
      if (isOnlySinResultados) {
        return [];
      }

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

  /**
   * Solicita la autorización fiscal (CAE) de un comprobante ante WSFEv1
   */
  public static async solicitarCae(
    auth: WsfeAuth,
    payload: {
      ptoVta: number;
      cbteTipo: number;
      detalle: {
        concepto: number;
        docTipo: number;
        docNro: string | number;
        cbteDesde: number;
        cbteHasta: number;
        cbteFch: string;
        impTotal: number;
        impTotConc: number;
        impNeto: number;
        impOpEx: number;
        impTrib: number;
        impIVA: number;
        fchServDesde?: string | undefined;
        fchServHasta?: string | undefined;
        fchVtoPago?: string | undefined;
        monId?: string | undefined;
        monCotiz?: number | undefined;
        condicionIvaReceptorId?: number | undefined;
        cbtesAsoc?: Array<{ tipo: number; ptoVta: number; nro: number; cuit?: string | undefined }> | undefined;
        iva?: Array<{ id: number; baseImp: number; importe: number }> | undefined;
      };
    },
    options?: WsfeClientOptions
  ): Promise<{
    resultado: 'A' | 'R' | 'P';
    reproceso?: string | undefined;
    cae?: string | undefined;
    caeFchVto?: string | undefined;
    cbteDesde: number;
    cbteHasta: number;
    cbteFch: string;
    observaciones: Array<{ code: number; message: string }>;
    errores: Array<{ code: number; message: string }>;
    eventos: Array<{ code: number; message: string }>;
    xmlRequest: string;
    xmlResponse: string;
  }> {
    const environment = options?.environment ?? 'homologation';
    const endpoint = this.ENDPOINTS[environment];
    const det = payload.detalle;

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fev="http://ar.gov.afip.dif.FEV1/">
  <soap:Body>
    <fev:FECAESolicitar>
      <fev:Auth>
        <fev:Token>${auth.token}</fev:Token>
        <fev:Sign>${auth.sign}</fev:Sign>
        <fev:Cuit>${auth.cuit}</fev:Cuit>
      </fev:Auth>
      <fev:FeCAEReq>
        <fev:FeCabReq>
          <fev:CantReg>1</fev:CantReg>
          <fev:PtoVta>${payload.ptoVta}</fev:PtoVta>
          <fev:CbteTipo>${payload.cbteTipo}</fev:CbteTipo>
        </fev:FeCabReq>
        <fev:FeDetReq>
          <fev:FECAEDetRequest>
            <fev:Concepto>${det.concepto}</fev:Concepto>
            <fev:DocTipo>${det.docTipo}</fev:DocTipo>
            <fev:DocNro>${det.docNro}</fev:DocNro>
            <fev:CbteDesde>${det.cbteDesde}</fev:CbteDesde>
            <fev:CbteHasta>${det.cbteHasta}</fev:CbteHasta>
            <fev:CbteFch>${det.cbteFch}</fev:CbteFch>
            <fev:ImpTotal>${det.impTotal.toFixed(2)}</fev:ImpTotal>
            <fev:ImpTotConc>${det.impTotConc.toFixed(2)}</fev:ImpTotConc>
            <fev:ImpNeto>${det.impNeto.toFixed(2)}</fev:ImpNeto>
            <fev:ImpOpEx>${det.impOpEx.toFixed(2)}</fev:ImpOpEx>
            <fev:ImpTrib>${det.impTrib.toFixed(2)}</fev:ImpTrib>
            <fev:ImpIVA>${det.impIVA.toFixed(2)}</fev:ImpIVA>
            ${det.fchServDesde ? `<fev:FchServDesde>${det.fchServDesde}</fev:FchServDesde>` : ''}
            ${det.fchServHasta ? `<fev:FchServHasta>${det.fchServHasta}</fev:FchServHasta>` : ''}
            ${det.fchVtoPago ? `<fev:FchVtoPago>${det.fchVtoPago}</fev:FchVtoPago>` : ''}
            <fev:MonId>${det.monId || 'PES'}</fev:MonId>
            <fev:MonCotiz>${det.monCotiz || 1}</fev:MonCotiz>
            ${det.condicionIvaReceptorId ? `<fev:CondicionIVAReceptorId>${det.condicionIvaReceptorId}</fev:CondicionIVAReceptorId>` : ''}
            ${
              det.cbtesAsoc && det.cbtesAsoc.length > 0
                ? `<fev:CbtesAsoc>
                    ${det.cbtesAsoc
                      .map(
                        (a) => `
                      <fev:CbteAsoc>
                        <fev:Tipo>${a.tipo}</fev:Tipo>
                        <fev:PtoVta>${a.ptoVta}</fev:PtoVta>
                        <fev:Nro>${a.nro}</fev:Nro>
                        ${a.cuit ? `<fev:Cuit>${a.cuit}</fev:Cuit>` : ''}
                      </fev:CbteAsoc>`
                      )
                      .join('')}
                   </fev:CbtesAsoc>`
                : ''
            }
            ${
              det.iva && det.iva.length > 0
                ? `<fev:Iva>
                    ${det.iva
                      .map(
                        (i) => `
                      <fev:AlicIva>
                        <fev:Id>${i.id}</fev:Id>
                        <fev:BaseImp>${i.baseImp.toFixed(2)}</fev:BaseImp>
                        <fev:Importe>${i.importe.toFixed(2)}</fev:Importe>
                      </fev:AlicIva>`
                      )
                      .join('')}
                   </fev:Iva>`
                : ''
            }
          </fev:FECAEDetRequest>
        </fev:FeDetReq>
      </fev:FeCAEReq>
    </fev:FECAESolicitar>
  </soap:Body>
</soap:Envelope>`.trim();

    const xmlResponse = await this.executeSoap(
      endpoint,
      'http://ar.gov.afip.dif.FEV1/FECAESolicitar',
      soapBody,
      options?.timeoutMs ?? 25000
    );

    const parser = new XMLParser({
      isArray: (name) => name === 'Err' || name === 'Obs' || name === 'Evt' || name === 'FECAEDetResponse'
    });
    const parsed = parser.parse(xmlResponse);
    const result =
      parsed['soap:Envelope']?.['soap:Body']?.['FECAESolicitarResponse']?.['FECAESolicitarResult'] ||
      parsed['Envelope']?.['Body']?.['FECAESolicitarResponse']?.['FECAESolicitarResult'];

    if (!result) {
      throw new InfrastructureError('Respuesta inesperada en FECAESolicitar');
    }

    const resultado = (result.FeCabResp?.Resultado ?? 'R') as 'A' | 'R' | 'P';
    const reproceso = result.FeCabResp?.Reproceso ? String(result.FeCabResp.Reproceso) : undefined;

    const detResponses = result.FeDetResp?.FECAEDetResponse ?? [];
    const firstDet = detResponses[0] || {};

    const observaciones: Array<{ code: number; message: string }> = (firstDet.Observaciones?.Obs ?? []).map(
      (o: { Code?: number; Msg?: string }) => ({
        code: Number(o.Code ?? 0),
        message: String(o.Msg ?? '')
      })
    );

    const errores: Array<{ code: number; message: string }> = (result.Errors?.Err ?? []).map(
      (e: { Code?: number; Msg?: string }) => ({
        code: Number(e.Code ?? 0),
        message: String(e.Msg ?? '')
      })
    );

    const eventos: Array<{ code: number; message: string }> = (result.Events?.Evt ?? []).map(
      (ev: { Code?: number; Msg?: string }) => ({
        code: Number(ev.Code ?? 0),
        message: String(ev.Msg ?? '')
      })
    );

    return {
      resultado,
      reproceso,
      cae: firstDet.CAE ? String(firstDet.CAE) : undefined,
      caeFchVto: firstDet.CAEFchVto ? String(firstDet.CAEFchVto) : undefined,
      cbteDesde: Number(firstDet.CbteDesde ?? det.cbteDesde),
      cbteHasta: Number(firstDet.CbteHasta ?? det.cbteHasta),
      cbteFch: String(firstDet.CbteFch ?? det.cbteFch),
      observaciones,
      errores,
      eventos,
      xmlRequest: soapBody,
      xmlResponse
    };
  }

  /**
   * Consulta el comprobante emitido en ARCA (utilizado para reconciliación y verificación de estados)
   */
  public static async consultarComprobante(
    auth: WsfeAuth,
    ptoVta: number,
    cbteTipo: number,
    cbteNro: number,
    options?: WsfeClientOptions
  ): Promise<{
    encontrado: boolean;
    resultado?: string;
    cae?: string;
    caeFchVto?: string;
    cbteDesde?: number;
    cbteHasta?: number;
    cbteFch?: string;
    impTotal?: number;
    impNeto?: number;
    impIVA?: number;
    docTipo?: number;
    docNro?: string;
    observaciones: Array<{ code: number; message: string }>;
    errores: Array<{ code: number; message: string }>;
  }> {
    const environment = options?.environment ?? 'homologation';
    const endpoint = this.ENDPOINTS[environment];

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fev="http://ar.gov.afip.dif.FEV1/">
  <soap:Body>
    <fev:FECompConsultar>
      <fev:Auth>
        <fev:Token>${auth.token}</fev:Token>
        <fev:Sign>${auth.sign}</fev:Sign>
        <fev:Cuit>${auth.cuit}</fev:Cuit>
      </fev:Auth>
      <fev:FeCompConsReq>
        <fev:CbteTipo>${cbteTipo}</fev:CbteTipo>
        <fev:CbteNro>${cbteNro}</fev:CbteNro>
        <fev:PtoVta>${ptoVta}</fev:PtoVta>
      </fev:FeCompConsReq>
    </fev:FECompConsultar>
  </soap:Body>
</soap:Envelope>`.trim();

    const xmlResponse = await this.executeSoap(
      endpoint,
      'http://ar.gov.afip.dif.FEV1/FECompConsultar',
      soapBody,
      options?.timeoutMs ?? 15000
    );

    const parser = new XMLParser({
      isArray: (name) => name === 'Err' || name === 'Obs' || name === 'Evt'
    });
    const parsed = parser.parse(xmlResponse);
    const result =
      parsed['soap:Envelope']?.['soap:Body']?.['FECompConsultarResponse']?.['FECompConsultarResult'] ||
      parsed['Envelope']?.['Body']?.['FECompConsultarResponse']?.['FECompConsultarResult'];

    if (!result) {
      throw new InfrastructureError('Respuesta inesperada en FECompConsultar');
    }

    const errores: Array<{ code: number; message: string }> = (result.Errors?.Err ?? []).map(
      (e: { Code?: number; Msg?: string }) => ({
        code: Number(e.Code ?? 0),
        message: String(e.Msg ?? '')
      })
    );

    const get = result.ResultGet;
    if (!get || !get.CodAutorizacion) {
      return {
        encontrado: false,
        observaciones: [],
        errores
      };
    }

    const observaciones: Array<{ code: number; message: string }> = (get.Observaciones?.Obs ?? []).map(
      (o: { Code?: number; Msg?: string }) => ({
        code: Number(o.Code ?? 0),
        message: String(o.Msg ?? '')
      })
    );

    return {
      encontrado: true,
      resultado: String(get.Resultado ?? ''),
      cae: String(get.CodAutorizacion ?? ''),
      caeFchVto: String(get.FchVto ?? ''),
      cbteDesde: Number(get.CbteDesde ?? cbteNro),
      cbteHasta: Number(get.CbteHasta ?? cbteNro),
      cbteFch: String(get.CbteFch ?? ''),
      impTotal: Number(get.ImpTotal ?? 0),
      impNeto: Number(get.ImpNeto ?? 0),
      impIVA: Number(get.ImpIVA ?? 0),
      docTipo: Number(get.DocTipo ?? 0),
      docNro: String(get.DocNro ?? ''),
      observaciones,
      errores
    };
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

