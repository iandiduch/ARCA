import forge from 'node-forge';
import crypto from 'node:crypto';

export interface GeneratedKeyAndCsr {
  privateKeyPem: string;
  csrPem: string;
}

export interface CertificateMetadata {
  validFrom: Date;
  validTo: Date;
  subject: string;
  issuer: string;
  serialNumber: string;
  fingerprint: string;
  isExpired: boolean;
}

export class CertificateManager {
  /**
   * Genera un par de claves RSA de 2048 bits y una Solicitud de Certificado (CSR PKCS#10)
   * formateada según las especificaciones de ARCA/AFIP.
   */
  public static generateKeyPairAndCsr(
    cuit: string,
    businessName: string,
    commonName = 'ARCA_POS_SERVICE'
  ): GeneratedKeyAndCsr {
    // 1. Generación de clave RSA 2048
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 });
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    // 2. Creación del CSR (PKCS#10)
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;

    // Atributos de sujeto requeridos por ARCA
    csr.setSubject([
      { name: 'countryName', value: 'AR' },
      { name: 'organizationName', value: businessName.slice(0, 60) },
      { name: 'commonName', value: commonName.slice(0, 60) },
      { name: 'serialNumber', value: `CUIT ${cuit}` }
    ]);

    // Firmar el CSR con la clave privada usando SHA-256
    csr.sign(keys.privateKey, forge.md.sha256.create());

    const csrPem = forge.pki.certificationRequestToPem(csr);

    return {
      privateKeyPem,
      csrPem
    };
  }

  /**
   * Inspecciona y valida un certificado X.509 en formato PEM
   */
  public static inspectCertificate(certPem: string): CertificateMetadata {
    const cert = forge.pki.certificateFromPem(certPem);

    const validFrom = cert.validity.notBefore;
    const validTo = cert.validity.notAfter;
    const isExpired = Date.now() > validTo.getTime();

    // Fingerprint SHA-256 en formato Hex
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const fingerprint = crypto
      .createHash('sha256')
      .update(Buffer.from(der, 'binary'))
      .digest('hex');

    const subjectStr = cert.subject.attributes
      .map((a: any) => `${a.name ?? 'attr'}=${String(a.value ?? '')}`)
      .join(', ');

    const issuerStr = cert.issuer.attributes
      .map((a: any) => `${a.name ?? 'attr'}=${String(a.value ?? '')}`)
      .join(', ');

    return {
      validFrom,
      validTo,
      subject: subjectStr,
      issuer: issuerStr,
      serialNumber: cert.serialNumber,
      fingerprint,
      isExpired
    };
  }

  /**
   * Comprueba criptográficamente si la clave privada corresponde al certificado X.509.
   */
  public static matchKeyAndCert(privateKeyPem: string, certPem: string): boolean {
    try {
      const challenge = 'arca_cert_verification_challenge_' + Date.now();

      // Firmar con la clave privada
      const signer = crypto.createSign('SHA256');
      signer.update(challenge);
      signer.end();
      const signature = signer.sign(privateKeyPem);

      // Verificar con la clave pública del certificado
      const verifier = crypto.createVerify('SHA256');
      verifier.update(challenge);
      verifier.end();
      return verifier.verify(certPem, signature);
    } catch {
      return false;
    }
  }
}
