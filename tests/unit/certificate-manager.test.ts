import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { CertificateManager } from '../../src/modules/arca/infrastructure/certificates/certificate-manager.js';

describe('Gestión de Certificados Digitales X.509 y CSR (CertificateManager)', () => {
  it('debe generar un par de claves RSA 2048 y un CSR en formato PEM', () => {
    const { privateKeyPem, csrPem } = CertificateManager.generateKeyPairAndCsr(
      '30503612891',
      'Servicios Generales S.A.'
    );

    expect(privateKeyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(csrPem).toContain('-----BEGIN CERTIFICATE REQUEST-----');
  });

  it('debe inspeccionar un certificado X.509 y comprobar correspondencia con su clave privada', () => {
    // Generar claves
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 });
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    // Crear un certificado X.509 firmado para el test
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '0123456789';
    cert.validity.notBefore = new Date(Date.now() - 3600000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
    cert.setSubject([
      { name: 'countryName', value: 'AR' },
      { name: 'organizationName', value: 'Test ARCA' },
      { name: 'commonName', value: 'computador1' }
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);

    // 1. Inspeccionar metadatos
    const metadata = CertificateManager.inspectCertificate(certPem);
    expect(metadata.isExpired).toBe(false);
    expect(metadata.fingerprint).toHaveLength(64); // SHA-256 hex
    expect(metadata.serialNumber).toBe('0123456789');

    // 2. Comprobar correspondencia de clave y certificado
    const isMatch = CertificateManager.matchKeyAndCert(privateKeyPem, certPem);
    expect(isMatch).toBe(true);

    // 3. Comprobar rechazo con otra clave privada distinta
    const anotherKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 });
    const anotherPrivatePem = forge.pki.privateKeyToPem(anotherKeys.privateKey);
    const isMismatch = CertificateManager.matchKeyAndCert(anotherPrivatePem, certPem);
    expect(isMismatch).toBe(false);
  });
});
