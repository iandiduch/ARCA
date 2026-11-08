import { XMLParser } from 'fast-xml-parser';
import { eq, and } from 'drizzle-orm';
import { getDatabase } from '../../../../infrastructure/database/connection.js';
import { wsaaAccessTickets } from '../../../../infrastructure/database/schema/wsaa-access-tickets.js';
import { TraBuilder } from './tra-builder.js';
import { CmsSigner } from './cms-signer.js';
import { FiscalError, InfrastructureError } from '../../../../core/errors/app-error.js';
import { logger } from '../../../../app/logger.js';
import { withAdvisoryLock } from '../../../../core/security/advisory-lock.js';
import { isArcaProductionAllowed } from '../../../../app/config.js';

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

// Margen de seguridad: reutilizar el TA sólo si le quedan al menos 15 minutos de vida
const SAFETY_MARGIN_MS = 15 * 60 * 1000;

/** WSAA rechaza el login porque ya emitió un TA vigente para ese certificado y servicio */
export class WsaaAlreadyAuthenticatedError extends FiscalError {}

export class WsaaClient {
  private static readonly inflightRenewals = new Map<string, Promise<WsaaCredentials>>();
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
    const cacheKey = `${fiscalIdentityId}:${service}:${environment}`;

    // Toda llamada autenticada a ARCA pasa por acá: una instalación no habilitada (staging restaurado desde un
    // backup de producción, notebook de desarrollo) nunca obtiene credenciales de producción ni emite facturas reales.
    if (environment === 'production' && !isArcaProductionAllowed()) {
      throw new FiscalError(
        'Esta instalación no está habilitada para operar contra ARCA producción (ALLOW_ARCA_PRODUCTION). No se solicitaron credenciales.'
      );
    }

    // 1. Revisar caché en base de datos
    const cached = await this.findCachedTicket(fiscalIdentityId, service, environment);
    if (cached && cached.expirationTime.getTime() > Date.now() + SAFETY_MARGIN_MS) {
      return { ...cached, fromCache: true };
    }

    // 2. Una sola renovación a la vez por identidad/servicio/entorno: en el proceso (single-flight)
    // y entre réplicas (bloqueo consultivo). WSAA rechaza un segundo login mientras el TA vigente no venza.
    const inflight = this.inflightRenewals.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const renewal = withAdvisoryLock(
      `wsaa:${cacheKey}`,
      async () => {
        const fresh = await this.findCachedTicket(fiscalIdentityId, service, environment);
        if (fresh && fresh.expirationTime.getTime() > Date.now() + SAFETY_MARGIN_MS) {
          return { ...fresh, fromCache: true };
        }

        try {
          return await this.requestNewTicket(fiscalIdentityId, privateKeyPem, certificatePem, service, environment, options);
        } catch (err) {
          // WSAA todavía considera vigente el TA anterior: si lo tenemos y no venció, seguir usándolo
          if (err instanceof WsaaAlreadyAuthenticatedError && fresh && fresh.expirationTime.getTime() > Date.now()) {
            logger.warn({ fiscalIdentityId, service, environment }, 'WSAA informa un TA vigente; se reutiliza el ticket en caché');
            return { ...fresh, fromCache: true };
          }
          throw err;
        }
      },
      {
        timeoutMs: (options?.timeoutMs ?? 15000) * 2,
        busyMessage: 'Se está renovando el ticket de acceso de ARCA para este comercio. Reintente en unos segundos.'
      }
    );

    this.inflightRenewals.set(cacheKey, renewal);
    try {
      return await renewal;
    } finally {
      this.inflightRenewals.delete(cacheKey);
    }
  }

  private static async findCachedTicket(
    fiscalIdentityId: string,
    service: string,
    environment: string
  ): Promise<Omit<WsaaCredentials, 'fromCache'> | null> {
    const db = getDatabase();
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

    return cached ? { token: cached.token, sign: cached.sign, expirationTime: cached.expirationTime } : null;
  }

  private static async requestNewTicket(
    fiscalIdentityId: string,
    privateKeyPem: string,
    certificatePem: string,
    service: string,
    environment: 'homologation' | 'production',
    options?: WsaaClientOptions
  ): Promise<WsaaCredentials> {
    const db = getDatabase();
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
      const faultText = `${String(fault.faultcode ?? '')} ${String(fault.faultstring ?? '')}`;
      if (/alreadyAuthenticated|ya posee un TA/i.test(faultText)) {
        throw new WsaaAlreadyAuthenticatedError(
          'Error de autenticación WSAA: ARCA ya emitió un ticket de acceso vigente para este certificado y servicio',
          undefined,
          { rawFault: faultString }
        );
      }
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
