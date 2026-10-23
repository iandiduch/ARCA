import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { TraBuilder } from '../../src/modules/arca/infrastructure/wsaa/tra-builder.js';
import { CmsSigner } from '../../src/modules/arca/infrastructure/wsaa/cms-signer.js';

describe('WSAA TRA y Firma Criptográfica CMS PKCS#7', () => {
  it('TraBuilder debe generar un XML con formato oficial loginTicketRequest', () => {
    const { xml, uniqueId } = TraBuilder.build({ service: 'wsfe' });

    expect(xml).toContain('<loginTicketRequest version="1.0">');
    expect(xml).toContain(`<uniqueId>${uniqueId}</uniqueId>`);
    expect(xml).toContain('<service>wsfe</service>');
    expect(xml).toContain('<generationTime>');
    expect(xml).toContain('<expirationTime>');
  });

  it('CmsSigner debe generar un CMS PKCS#7 válido en base64 con contenido embebido', () => {
    // Generar claves y certificado de prueba
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 });
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 3600000);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);

    const { xml } = TraBuilder.build({ service: 'wsfe' });
    const cmsBase64 = CmsSigner.sign(xml, privateKeyPem, certPem);

    expect(typeof cmsBase64).toBe('string');
    expect(cmsBase64.length).toBeGreaterThan(100);

    // Verificar que se puede decodificar de Base64 a ASN.1 DER
    const der = forge.util.decode64(cmsBase64);
    const asn1 = forge.asn1.fromDer(der);
    expect(asn1.tagClass).toBe(forge.asn1.Class.UNIVERSAL);
  });
});
