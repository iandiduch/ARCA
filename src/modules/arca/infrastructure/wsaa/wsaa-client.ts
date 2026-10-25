import { XMLParser } from 'fast-xml-parser';
import { eq, and } from 'drizzle-orm';
import { getDatabase } from '../../../../infrastructure/database/connection.js';
import { wsaaAccessTickets } from '../../../../infrastructure/database/schema/wsaa-access-tickets.js';
import { TraBuilder } from './tra-builder.js';
import { CmsSigner } from './cms-signer.js';
import { FiscalError, InfrastructureError } from '../../../../core/errors/app-error.js';
import { logger } from '../../../../app/logger.js';

export interface WsaaCredentials {
  token: string;
  sign: string;
  expirationTime: Date;
  fromCache: boolean;
}

export interface WsaaClientOptions {
  environment?: 'homologation' | 'production' | undefined;
  service?: string | undefined;
  timeoutMs?: number | undefined;
}

export class WsaaClient {
  private static readonly ENDPOINTS = {
    homologation: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    production: 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
  };

  /**
   * Obtiene un Ticket de Acceso (TA) válido, reutilizando el caché de PostgreSQL si no ha expirado.
   */
  public static async getTicket(
    fiscalIdentityId: string,
    privateKeyPem: string,
    certificatePem: string,
    options?: WsaaClientOptions
  ): Promise<WsaaCredentials> {
    const environment = options?.environment ?? 'homologation';
    const service = options?.service ?? 'wsfe';
    const db = getDatabase();

    // 1. Revisar caché en base de datos
    const [cached] = await db
      .select()
      .from(wsaaAccessTickets)
      .where(
        and(
          eq(wsaaAccessTickets.fiscalIdentityId, fiscalIdentityId),
          eq(wsaaAccessTickets.service, service),
          eq(wsaaAccessTickets.environment, environment)
        )
      )
      .limit(1);

    // Margen de seguridad: reutilizar sólo si le quedan al menos 15 minutos de vida
    const SAFETY_MARGIN_MS = 15 * 60 * 1000;
    if (cached && cached.expirationTime.getTime() > Date.now() + SAFETY_MARGIN_MS) {
      return {
        token: cached.token,
        sign: cached.sign,
        expirationTime: cached.expirationTime,
        fromCache: true
      };
    }

    // 2. Si no hay ticket vigente, solicitar uno nuevo a WSAA
    logger.info({ fiscalIdentityId, service, environment }, 'Solicitando nuevo Ticket de Acceso a WSAA');

    const { xml: traXml } = TraBuilder.build({ service });
    const cmsBase64 = CmsSigner.sign(traXml, privateKeyPem, certificatePem);

    const endpoint = this.ENDPOINTS[environment];
    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cmsBase64}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`.trim();

    const response = await this.executeSoapRequest(endpoint, soapEnvelope, options?.timeoutMs ?? 15000);
    const parsed = this.parseLoginCmsResponse(response);

    // 3. Guardar en caché (upsert atómico resistente a concurrencia)
    await db
      .insert(wsaaAccessTickets)
      .values({
        fiscalIdentityId,
        service,
        environment,
        token: parsed.token,
        sign: parsed.sign,
        generationTime: parsed.generationTime,
        expirationTime: parsed.expirationTime
      })
      .onConflictDoUpdate({
        target: [
          wsaaAccessTickets.fiscalIdentityId,
          wsaaAccessTickets.service,
          wsaaAccessTickets.environment
        ],
        set: {
          token: parsed.token,
          sign: parsed.sign,
          generationTime: parsed.generationTime,
          expirationTime: parsed.expirationTime
        }
      });

    return {
      token: parsed.token,
      sign: parsed.sign,
      expirationTime: parsed.expirationTime,
      fromCache: false
    };
  }

  private static async executeSoapRequest(url: string, body: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: ''
        },
        body,
        signal: controller.signal
      });

      const responseText = await res.text();

      if (!res.ok && !responseText.includes('<soapenv:Fault>') && !responseText.includes('<faultstring>')) {
        throw new InfrastructureError(`WSAA respondió con HTTP ${res.status}: ${res.statusText}`);
      }

      return responseText;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new InfrastructureError(`Timeout al conectar con WSAA (${timeoutMs}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private static parseLoginCmsResponse(soapXml: string): {
    token: string;
    sign: string;
    generationTime: Date;
    expirationTime: Date;
  } {
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(soapXml);

    // Verificar si vino un SOAP Fault
    const body = parsed['soapenv:Envelope']?.['soapenv:Body'] || parsed['Envelope']?.['Body'];
    const fault = body?.['soapenv:Fault'] || body?.['Fault'];

    if (fault) {
      const faultString = fault.faultstring || fault.faultcode || 'Error desconocido de WSAA';
      const friendlyMessage = this.mapWsaaError(faultString);
      throw new FiscalError(`Error de autenticación WSAA: ${friendlyMessage}`, undefined, { rawFault: faultString });
    }

    const returnXmlString =
      body?.['loginCmsResponse']?.['loginCmsReturn'] || body?.['loginCmsReturn'];

    if (!returnXmlString || typeof returnXmlString !== 'string') {
      throw new InfrastructureError('Respuesta malformada de WSAA: loginCmsReturn ausente');
    }

    // El loginCmsReturn es a su vez un string XML
    const ticketDoc = parser.parse(returnXmlString);
    const ticketResponse = ticketDoc.loginTicketResponse;

    if (!ticketResponse?.credentials?.token || !ticketResponse?.credentials?.sign) {
      throw new InfrastructureError('Respuesta malformada de WSAA: credenciales ausentes en el ticket');
    }

    const token = ticketResponse.credentials.token;
    const sign = ticketResponse.credentials.sign;
    const genTimeStr = ticketResponse.header?.generationTime;
    const expTimeStr = ticketResponse.header?.expirationTime;

    return {
      token,
      sign,
      generationTime: genTimeStr ? new Date(genTimeStr) : new Date(),
      expirationTime: expTimeStr ? new Date(expTimeStr) : new Date(Date.now() + 12 * 60 * 60 * 1000)
    };
  }

  private static mapWsaaError(faultString: string): string {
    if (faultString.includes('Certificado no emitido por AC de confianza')) {
      return 'El certificado digital no fue emitido por una Autoridad Certificante reconocida por ARCA';
    }
    if (faultString.includes('Computador no autorizado')) {
      return 'El certificado no se encuentra asociado al servicio fiscal en ARCA (falta delegación o autorización)';
    }
    if (faultString.includes('Firma inválida')) {
      return 'La firma criptográfica del mensaje es inválida o la clave privada no coincide';
    }
    if (faultString.includes('El tiempo de expiración es inferior')) {
      return 'Error de sincronización horaria: la fecha del ticket ya expiró';
    }
    return faultString;
  }
}
