import { XMLParser } from 'fast-xml-parser';
import { FiscalError, InfrastructureError, NotFoundError } from '../../../../core/errors/app-error.js';
import { logger } from '../../../../app/logger.js';
import type { WsfeAuth, WsfeClientOptions } from '../wsfev1/wsfev1-client.js';

export interface PadronPersonaResult {
  cuit: string;
  businessName: string;
  personType: 'FISICA' | 'JURIDICA';
  status: string;
  fiscalCondition: 'IVA_RESPONSABLE_INSCRIPTO' | 'RESPONSABLE_MONOTRIBUTO' | 'IVA_EXENTO' | 'CONSUMIDOR_FINAL';
  fiscalConditionCode: number;
  fiscalConditionName: string;
  address?: {
    street?: string | undefined;
    city?: string | undefined;
    province?: string | undefined;
    postalCode?: string | undefined;
  } | undefined;
  queriedAt: Date;
}

export class PadronClient {
  private static readonly ENDPOINTS = {
    homologation: 'https://awshomo.afip.gob.ar/sr-padron/webservices/personaServiceA5',
    production: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5'
  };

  /**
   * Consulta los datos fiscales de un CUIT ante el Padrón (Constancia de Inscripción) de ARCA
   */
  public static async getPersona(
    auth: WsfeAuth,
    targetCuit: string,
    options?: WsfeClientOptions
  ): Promise<PadronPersonaResult> {
    const environment = options?.environment ?? 'homologation';
    const endpoint = this.ENDPOINTS[environment];

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a5:getPersona_v2>
      <token>${auth.token}</token>
      <sign>${auth.sign}</sign>
      <cuitRepresentada>${auth.cuit}</cuitRepresentada>
      <idPersona>${targetCuit}</idPersona>
    </a5:getPersona_v2>
  </soapenv:Body>
</soapenv:Envelope>`.trim();

    try {
      const xmlResponse = await this.executeSoap(
        endpoint,
        'http://a5.soap.ws.server.puc.sr/getPersona_v2',
        soapBody,
        options?.timeoutMs ?? 15000
      );

      const parser = new XMLParser({
        isArray: (name) => name === 'impuesto' || name === 'errorConstancia'
      });
      const parsed = parser.parse(xmlResponse);
      logger.info({ xmlResponse, parsed }, 'Respuesta cruda de Padrón Constancia de Inscripción de ARCA');

      const body = parsed['soapenv:Envelope']?.['soapenv:Body'] || parsed['Envelope']?.['Body'] || parsed['soap:Envelope']?.['soap:Body'];
      const fault = body?.['soap:Fault'] || body?.['soapenv:Fault'] || body?.['Fault'];
      if (fault) {
        const faultStr = String(fault.faultstring || 'Error en consulta de padrón');
        if (faultStr.toLowerCase().includes('no existe') || faultStr.toLowerCase().includes('no encontrada') || faultStr.toLowerCase().includes('no encontrado')) {
          throw new NotFoundError(`El CUIT ${targetCuit} no fue encontrado en el Padrón de ARCA`);
        }
        throw new FiscalError(`Error de Padrón ARCA: ${faultStr}`);
      }

      const personaReturn =
        body?.['getPersona_v2Response']?.['personaReturn'] ||
        parsed['getPersona_v2Response']?.['personaReturn'] ||
        body?.['getPersonaResponse']?.['personaReturn'] ||
        parsed['getPersonaResponse']?.['personaReturn'];

      if (!personaReturn) {
        throw new InfrastructureError('Respuesta inesperada al consultar Padrón Constancia de Inscripción de ARCA');
      }

      if (personaReturn.errorConstancia?.length) {
        const errors = Array.isArray(personaReturn.errorConstancia)
          ? personaReturn.errorConstancia.map(String)
          : [String(personaReturn.errorConstancia)];
        const msg = errors.join(', ');
        if (msg.toLowerCase().includes('no existe') || msg.toLowerCase().includes('no encontrada') || msg.toLowerCase().includes('no encontrado')) {
          throw new NotFoundError(`El CUIT ${targetCuit} no fue encontrado en el Padrón de ARCA`);
        }
        throw new FiscalError(`Error de Padrón ARCA: ${msg}`);
      }

      const dg = personaReturn.datosGenerales || {};
      const razonSocial =
        dg.razonSocial ||
        [dg.apellido, dg.nombre].filter(Boolean).join(' ') ||
        `Contribuyente ${targetCuit}`;

      const tipoPersona = dg.tipoPersona === 'JURIDICA' ? 'JURIDICA' : 'FISICA';
      const estadoClave = dg.estadoClave || 'ACTIVO';

      // Impuestos del Régimen General y de Monotributo
      const regGenImpuestos = Array.isArray(personaReturn.datosRegimenGeneral?.impuesto)
        ? personaReturn.datosRegimenGeneral.impuesto
        : personaReturn.datosRegimenGeneral?.impuesto
          ? [personaReturn.datosRegimenGeneral.impuesto]
          : [];

      const monotributoImpuestos = Array.isArray(personaReturn.datosMonotributo?.impuesto)
        ? personaReturn.datosMonotributo.impuesto
        : personaReturn.datosMonotributo?.impuesto
          ? [personaReturn.datosMonotributo.impuesto]
          : [];

      const impuestos = [...regGenImpuestos, ...monotributoImpuestos];

      let fiscalCondition: PadronPersonaResult['fiscalCondition'] = 'CONSUMIDOR_FINAL';
      let fiscalConditionCode = 5;
      let fiscalConditionName = 'Consumidor Final';

      // Identificación de condición impositiva según normativas de AFIP/ARCA:
      // - 30: IVA (Responsable Inscripto)
      // - 20, 21, 22, 23, 24 o presencia de datosMonotributo: Monotributista
      // - 32, 33, 34: IVA Exento
      const hasIva = impuestos.some((i: { idImpuesto?: number | string }) => Number(i.idImpuesto) === 30);
      const hasMonotributo =
        Boolean(personaReturn.datosMonotributo?.categoriaMonotributo) ||
        impuestos.some((i: { idImpuesto?: number | string }) => [20, 21, 22, 23, 24].includes(Number(i.idImpuesto)));
      const hasExento = impuestos.some((i: { idImpuesto?: number | string }) => [32, 33, 34].includes(Number(i.idImpuesto)));

      if (hasIva) {
        fiscalCondition = 'IVA_RESPONSABLE_INSCRIPTO';
        fiscalConditionCode = 1;
        fiscalConditionName = 'IVA Responsable Inscripto';
      } else if (hasMonotributo) {
        fiscalCondition = 'RESPONSABLE_MONOTRIBUTO';
        fiscalConditionCode = 6;
        fiscalConditionName = 'Responsable Monotributo';
      } else if (hasExento) {
        fiscalCondition = 'IVA_EXENTO';
        fiscalConditionCode = 4;
        fiscalConditionName = 'IVA Sujeto Exento';
      }

      const dom = dg.domicilioFiscal || {};

      return {
        cuit: targetCuit,
        businessName: String(razonSocial).trim(),
        personType: tipoPersona,
        status: estadoClave,
        fiscalCondition,
        fiscalConditionCode,
        fiscalConditionName,
        address: {
          street: dom.direccion ? String(dom.direccion) : undefined,
          city: dom.localidad ? String(dom.localidad) : undefined,
          province: dom.descripcionProvincia ? String(dom.descripcionProvincia) : undefined,
          postalCode: dom.codPostal ? String(dom.codPostal) : undefined
        },
        queriedAt: new Date()
      };
    } catch (err) {
      logger.warn({ err, targetCuit }, 'Aviso en consulta de Padrón ARCA Constancia de Inscripción');
      throw err;
    }
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
      return responseText;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new InfrastructureError(`Timeout al conectar con Padrón ARCA (${timeoutMs}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
