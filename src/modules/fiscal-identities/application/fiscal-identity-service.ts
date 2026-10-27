import { FiscalIdentityRepository } from '../infrastructure/fiscal-identity-repository.js';
import { CertificateManager } from '../../arca/infrastructure/certificates/certificate-manager.js';
import { EncryptionService } from '../../../core/security/encryption.js';
import { WsaaClient } from '../../arca/infrastructure/wsaa/wsaa-client.js';
import { Wsfev1Client } from '../../arca/infrastructure/wsfev1/wsfev1-client.js';
import { cleanDocumentNumber, isValidCuit } from '../../../core/fiscal/cuit-validator.js';
import { ValidationError, ConflictError, NotFoundError } from '../../../core/errors/app-error.js';
import { AuditService } from '../../audit/application/audit-service.js';
import { loadConfig } from '../../../app/config.js';
import { logger } from '../../../app/logger.js';
import type { FiscalIdentity } from '../../../infrastructure/database/schema/fiscal-identities.js';

export interface CreateIdentityInput {
  cuit: string;
  businessName: string;
  fantasyName?: string | undefined;
  commercialAddress?: string | undefined;
  environment?: 'homologation' | 'production' | undefined;
  taxCondition?: string | undefined;
  grossIncomeNumber?: string | undefined;
  activityStartDate?: string | undefined;
  connectionType?: 'DELEGATION' | 'OWN_CERTIFICATE' | undefined;
}

export class FiscalIdentityService {
  constructor(private readonly repo = new FiscalIdentityRepository()) {}

  /**
   * Paso 1: Identificar el comercio y crear la identidad fiscal
   */
  public async createIdentity(
    tenantId: string,
    input: CreateIdentityInput,
    userId?: string
  ): Promise<FiscalIdentity> {
    const cleanCuit = cleanDocumentNumber(input.cuit);
    if (!isValidCuit(cleanCuit)) {
      throw new ValidationError(`El CUIT "${input.cuit}" no es válido según algoritmo Módulo 11 de ARCA`);
    }

    const environment = input.environment ?? 'homologation';
    const connectionType = input.connectionType ?? 'DELEGATION';

    const existing = await this.repo.findByCuit(tenantId, cleanCuit, environment);
    if (existing) {
      throw new ConflictError(
        `Ya existe una identidad configurada con el CUIT ${cleanCuit} para el entorno ${environment}`
      );
    }

    const initialStatus = connectionType === 'DELEGATION' ? 'AUTHORIZATION_PENDING' : 'IDENTITY_PENDING';
    const statusReason =
      connectionType === 'DELEGATION'
        ? 'Pendiente de delegación del servicio en el portal de ARCA al CUIT de la plataforma'
        : 'Pendiente de generación de solicitud de certificado digital (CSR)';

    const identity = await this.repo.create({
      tenantId,
      cuit: cleanCuit,
      businessName: input.businessName.trim(),
      fantasyName: input.fantasyName?.trim() || null,
      commercialAddress: input.commercialAddress?.trim() || null,
      environment,
      taxCondition: input.taxCondition ?? 'RESPONSABLE_MONOTRIBUTO',
      grossIncomeNumber: input.grossIncomeNumber?.trim() || null,
      activityStartDate: input.activityStartDate || null,
      connectionType,
      status: initialStatus,
      statusReason
    });

    await AuditService.record({
      tenantId,
      userId,
      action: 'FISCAL_IDENTITY_CREATED',
      entityType: 'fiscal_identity',
      entityId: identity.id,
      payload: { cuit: identity.cuit, environment: identity.environment, connectionType }
    });

    return identity;
  }

  /**
   * Actualiza los datos identificatorios/membrete de la identidad fiscal.
   * Se usa, por ejemplo, para sincronizar el nombre de fantasía y el domicilio
   * comercial que se imprimen en el comprobante, sin recrear la identidad.
   */
  public async updateIdentityData(
    tenantId: string,
    identityId: string,
    input: {
      businessName?: string | undefined;
      fantasyName?: string | undefined;
      commercialAddress?: string | undefined;
      grossIncomeNumber?: string | undefined;
      activityStartDate?: string | undefined;
      taxCondition?: string | undefined;
    },
    userId?: string
  ): Promise<FiscalIdentity> {
    await this.getIdentityById(tenantId, identityId);

    const data: Record<string, string | null> = {};
    if (input.businessName !== undefined) data.businessName = input.businessName.trim();
    if (input.fantasyName !== undefined) data.fantasyName = input.fantasyName.trim();
    if (input.commercialAddress !== undefined) data.commercialAddress = input.commercialAddress.trim();
    if (input.grossIncomeNumber !== undefined) data.grossIncomeNumber = input.grossIncomeNumber.trim();
    if (input.activityStartDate !== undefined) data.activityStartDate = input.activityStartDate.trim();
    if (input.taxCondition !== undefined && input.taxCondition.trim()) data.taxCondition = input.taxCondition.trim();

    const updated = await this.repo.update(tenantId, identityId, data);
    if (!updated) {
      throw new NotFoundError(`Identidad fiscal con ID "${identityId}" no encontrada`);
    }

    await AuditService.record({
      tenantId,
      userId,
      action: 'FISCAL_IDENTITY_UPDATED',
      entityType: 'fiscal_identity',
      entityId: identityId,
      payload: data
    });

    return updated;
  }

  /**
   * Paso 2: Generar automáticamente la clave privada RSA 2048 y el CSR (PKCS#10)
   */
  public async generateCertificateRequest(tenantId: string, identityId: string, userId?: string) {
    const identity = await this.getIdentityById(tenantId, identityId);

    const { privateKeyPem, csrPem } = CertificateManager.generateKeyPairAndCsr(
      identity.cuit,
      identity.businessName
    );

    // Cifrar la clave privada en reposo con AES-256-GCM
    const encryptedKey = EncryptionService.encrypt(privateKeyPem);

    await this.repo.saveCertificate({
      fiscalIdentityId: identity.id,
      encryptedPrivateKey: encryptedKey.ciphertext,
      privateKeyIv: encryptedKey.iv,
      privateKeyAuthTag: encryptedKey.authTag,
      csr: csrPem,
      active: true
    });

    await this.repo.update(tenantId, identity.id, {
      status: 'CERTIFICATE_PENDING',
      statusReason: 'CSR generado. Descargue el archivo y tramítelo en el portal de ARCA.'
    });

    await AuditService.record({
      tenantId,
      userId,
      action: 'CERTIFICATE_REQUEST_GENERATED',
      entityType: 'fiscal_identity',
      entityId: identity.id
    });

    return {
      fiscalIdentityId: identity.id,
      cuit: identity.cuit,
      csrPem,
      instructions:
        identity.environment === 'homologation'
          ? 'Ingrese al servicio "WSASS - Autogestión Certificados Homologación" en ARCA y suba este archivo CSR.'
          : 'Ingrese a "Administración de Certificados Digitales" con Clave Fiscal en ARCA y suba este archivo CSR.'
    };
  }

  /**
   * Paso 4: Cargar y validar el certificado público emitido por ARCA
   */
  public async uploadCertificate(
    tenantId: string,
    identityId: string,
    certPem: string,
    userId?: string
  ) {
    const identity = await this.getIdentityById(tenantId, identityId);
    const certRecord = await this.repo.getActiveCertificate(identity.id);

    if (!certRecord) {
      throw new ValidationError('No existe una solicitud de certificado previa para este comercio');
    }

    // Desencriptar la clave privada almacenada para verificar la correspondencia
    const privateKeyPem = EncryptionService.decrypt({
      ciphertext: certRecord.encryptedPrivateKey,
      iv: certRecord.privateKeyIv,
      authTag: certRecord.privateKeyAuthTag
    });

    const isMatch = CertificateManager.matchKeyAndCert(privateKeyPem, certPem);
    if (!isMatch) {
      throw new ValidationError(
        'El certificado público cargado no corresponde a la clave privada generada para este comercio'
      );
    }

    const metadata = CertificateManager.inspectCertificate(certPem);
    if (metadata.isExpired) {
      throw new ValidationError(`El certificado ya se encuentra vencido (expiró el ${metadata.validTo.toISOString()})`);
    }

    await this.repo.saveCertificate({
      fiscalIdentityId: identity.id,
      encryptedPrivateKey: certRecord.encryptedPrivateKey,
      privateKeyIv: certRecord.privateKeyIv,
      privateKeyAuthTag: certRecord.privateKeyAuthTag,
      csr: certRecord.csr,
      certificate: certPem,
      certificateFingerprint: metadata.fingerprint,
      validFrom: metadata.validFrom,
      validTo: metadata.validTo,
      active: true
    });

    await this.repo.update(tenantId, identity.id, {
      status: 'AUTHORIZATION_PENDING',
      statusReason: 'Certificado verificado. Recuerde asociar el computador fiscal al servicio "Facturación Electrónica" en ARCA.'
    });

    await AuditService.record({
      tenantId,
      userId,
      action: 'CERTIFICATE_UPLOADED',
      entityType: 'fiscal_identity',
      entityId: identity.id,
      payload: { fingerprint: metadata.fingerprint, validTo: metadata.validTo }
    });

    return {
      message: 'Certificado cargado y validado exitosamente',
      metadata
    };
  }

  /**
   * Paso 5: Probar la conexión y validar acceso con ARCA (WSAA + WSFEv1)
   */
  public async testConnection(tenantId: string, identityId: string, userId?: string) {
    const identity = await this.getIdentityById(tenantId, identityId);

    await this.repo.update(tenantId, identity.id, {
      status: 'VALIDATING',
      statusReason: 'Comprobando conectividad con los servidores de ARCA...'
    });

    try {
      // 1. Diagnóstico de servidores WSFEv1
      const dummy = await Wsfev1Client.dummy({ environment: identity.environment as any });
      if (!dummy.isOk) {
        throw new Error('Los servidores de ARCA (WSFEv1) reportan problemas de disponibilidad');
      }

      // 2. Obtener clave y certificado
      const certRecord = await this.repo.getActiveCertificate(identity.id);
      if (!certRecord || !certRecord.certificate) {
        throw new ValidationError('Falta cargar el certificado X.509 de ARCA para este comercio');
      }

      const privateKeyPem = EncryptionService.decrypt({
        ciphertext: certRecord.encryptedPrivateKey,
        iv: certRecord.privateKeyIv,
        authTag: certRecord.privateKeyAuthTag
      });

      // 3. Autenticación ante WSAA
      const ta = await WsaaClient.getTicket(identity.id, privateKeyPem, certRecord.certificate, {
        environment: identity.environment as any,
        service: 'wsfe'
      });

      // 4. Consulta de Puntos de Venta para confirmar autorización plena
      const ptos = await Wsfev1Client.getPuntosVenta(
        {
          token: ta.token,
          sign: ta.sign,
          cuit: identity.cuit
        },
        { environment: identity.environment as any }
      );

      // Guardar puntos de venta detectados (o crear Punto 1 si el padrón no tiene ninguno en testing)
      if (ptos.length === 0) {
        await this.repo.syncPointsOfSale(identity.id, [
          {
            fiscalIdentityId: identity.id,
            number: 1,
            type: 'RECEPCION_ELECTRONICA',
            description: 'Punto de Venta 1 (Homologación)',
            active: true
          }
        ]);
      } else {
        await this.repo.syncPointsOfSale(
          identity.id,
          ptos.map((p) => ({
            fiscalIdentityId: identity.id,
            number: p.nro,
            type: p.emisionTipo,
            description: `Punto de Venta ${p.nro} (${p.emisionTipo})`,
            active: !p.bloqueado
          }))
        );
      }

      // Conexión exitosa
      const updated = await this.repo.update(tenantId, identity.id, {
        status: 'CONNECTED',
        statusReason: 'Conexión fiscal validada y autorizada con ARCA',
        lastValidatedAt: new Date()
      });

      await AuditService.record({
        tenantId,
        userId,
        action: 'CONNECTION_TEST_SUCCESS',
        entityType: 'fiscal_identity',
        entityId: identity.id,
        payload: { puntosVenta: ptos.length }
      });

      return {
        ok: true,
        status: 'CONNECTED',
        message: '¡Comercio conectado exitosamente con ARCA!',
        puntosVenta: ptos,
        lastValidatedAt: updated?.lastValidatedAt
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Error desconocido al validar con ARCA';
      logger.warn({ err, identityId }, 'Fallo en la prueba de conexión con ARCA');

      await this.repo.update(tenantId, identity.id, {
        status: 'ACTION_REQUIRED',
        statusReason: errorMsg
      });

      await AuditService.record({
        tenantId,
        userId,
        action: 'CONNECTION_TEST_FAILED',
        entityType: 'fiscal_identity',
        entityId: identity.id,
        payload: { error: errorMsg }
      });

      return {
        ok: false,
        status: 'ACTION_REQUIRED',
        message: errorMsg
      };
    }
  }

  public async getIdentityById(tenantId: string, id: string): Promise<FiscalIdentity> {
    const identity = await this.repo.findById(tenantId, id);
    if (!identity) {
      throw new NotFoundError(`Identidad fiscal con ID "${id}" no encontrada`);
    }
    return identity;
  }

  public async listIdentities(tenantId: string): Promise<FiscalIdentity[]> {
    return this.repo.listByTenant(tenantId);
  }

  /**
   * Elimina una identidad fiscal. Se bloquea si ya existen comprobantes emitidos,
   * para no destruir historial fiscal autorizado por ARCA.
   */
  public async deleteIdentity(tenantId: string, id: string, userId?: string): Promise<void> {
    const identity = await this.getIdentityById(tenantId, id);

    const invoiceCount = await this.repo.countInvoices(identity.id);
    if (invoiceCount > 0) {
      throw new ConflictError(
        `No se puede eliminar la identidad fiscal ${identity.cuit}: posee ${invoiceCount} comprobante(s) emitido(s).`
      );
    }

    await this.repo.delete(tenantId, identity.id);

    await AuditService.record({
      tenantId,
      userId,
      action: 'FISCAL_IDENTITY_DELETED',
      entityType: 'fiscal_identity',
      entityId: identity.id,
      payload: { cuit: identity.cuit, environment: identity.environment }
    });
  }

  public async getStatus(tenantId: string, id: string) {
    const identity = await this.getIdentityById(tenantId, id);
    const cert = await this.repo.getActiveCertificate(identity.id);
    const ptos = await this.repo.getPointsOfSale(identity.id);

    return {
      id: identity.id,
      cuit: identity.cuit,
      businessName: identity.businessName,
      fantasyName: identity.fantasyName,
      commercialAddress: identity.commercialAddress,
      environment: identity.environment,
      connectionType: identity.connectionType,
      status: identity.status,
      statusReason: identity.statusReason,
      lastValidatedAt: identity.lastValidatedAt,
      hasCertificate: Boolean(cert?.certificate),
      certificateValidTo: cert?.validTo,
      puntosVenta: ptos.map((p) => ({
        id: p.id,
        number: p.number,
        type: p.type,
        active: p.active
      }))
    };
  }
}
