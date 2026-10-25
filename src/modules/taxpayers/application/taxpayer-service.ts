import { isValidCuit, cleanDocumentNumber } from '../../../core/fiscal/cuit-validator.js';
import { FiscalIdentityRepository } from '../../fiscal-identities/infrastructure/fiscal-identity-repository.js';
import { WsaaClient } from '../../arca/infrastructure/wsaa/wsaa-client.js';
import { EncryptionService } from '../../../core/security/encryption.js';
import { PadronClient, type PadronPersonaResult } from '../../arca/infrastructure/padron/padron-client.js';
import { ValidationError, NotFoundError } from '../../../core/errors/app-error.js';
import { logger } from '../../../app/logger.js';

interface CacheEntry {
  data: PadronPersonaResult;
  expiresAt: number;
}

export class TaxpayerService {
  private fiscalRepo = new FiscalIdentityRepository();
  private static cache = new Map<string, CacheEntry>();
  private static CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
  private static MAX_CACHE_ENTRIES = 5000;

  /**
   * Limpia la caché en memoria (útil para pruebas)
   */
  public static clearCache(): void {
    TaxpayerService.cache.clear();
  }

  /**
   * Retorna el número de registros en caché en memoria
   */
  public static getCacheSize(): number {
    return TaxpayerService.cache.size;
  }

  /**
   * Consulta los datos fiscales oficiales de un contribuyente en el Padrón ARCA
   */
  public async getTaxpayerByCuit(tenantId: string, rawCuit: string): Promise<PadronPersonaResult> {
    const cuit = cleanDocumentNumber(rawCuit);

    if (!isValidCuit(cuit)) {
      throw new ValidationError(`El CUIT "${rawCuit}" no es válido según el algoritmo oficial Módulo 11`);
    }

    // 1. Obtener identidad fiscal del tenant para autorizar la consulta
    const identities = await this.fiscalRepo.listByTenant(tenantId);
    const activeIdentity = identities.find((i) => i.status === 'CONNECTED') || identities[0];

    if (!activeIdentity) {
      throw new ValidationError(
        'El comercio debe contar con al menos una identidad fiscal configurada para consultar el padrón de ARCA'
      );
    }

    // 2. Verificar caché en memoria
    const cached = TaxpayerService.cache.get(cuit);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const cert = await this.fiscalRepo.getActiveCertificate(activeIdentity.id);
    if (!cert || !cert.certificate) {
      throw new ValidationError(
        `La identidad fiscal ${activeIdentity.cuit} no posee un certificado X.509 activo`
      );
    }

    const privateKeyPem = EncryptionService.decrypt({
      ciphertext: cert.encryptedPrivateKey,
      iv: cert.privateKeyIv,
      authTag: cert.privateKeyAuthTag
    });

    try {
      const wsaaCreds = await WsaaClient.getTicket(
        activeIdentity.id,
        privateKeyPem,
        cert.certificate,
        {
          environment: activeIdentity.environment as 'homologation' | 'production',
          service: 'ws_sr_padron_a5'
        }
      );

      const result = await PadronClient.getPersona(
        {
          token: wsaaCreds.token,
          sign: wsaaCreds.sign,
          cuit: activeIdentity.cuit
        },
        cuit,
        {
          environment: activeIdentity.environment as 'homologation' | 'production'
        }
      );

      // Guardar en caché con control de tamaño para prevenir fugas de memoria
      if (TaxpayerService.cache.size >= TaxpayerService.MAX_CACHE_ENTRIES) {
        const oldestKey = TaxpayerService.cache.keys().next().value;
        if (oldestKey) TaxpayerService.cache.delete(oldestKey);
      }
      TaxpayerService.cache.set(cuit, {
        data: result,
        expiresAt: Date.now() + TaxpayerService.CACHE_TTL_MS
      });

      return result;
    } catch (err) {
      logger.warn({ err, cuit }, 'Error al consultar servicio A5 de ARCA. Generando resolución estándar.');
      throw err;
    }
  }
}
