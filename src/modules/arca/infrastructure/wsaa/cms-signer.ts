import forge from 'node-forge';

export class CmsSigner {
  /**
   * Firma criptográficamente el XML del TRA según las especificaciones PKCS#7 / CMS de ARCA
   * utilizando SHA-256 y formato DER codificado en Base64 con contenido embebido (nodetach).
   */
  public static sign(traXml: string, privateKeyPem: string, certificatePem: string): string {
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(traXml, 'utf8');

    const cert = forge.pki.certificateFromPem(certificatePem);
    p7.addCertificate(cert);

    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
    p7.addSigner({
      key: privateKey,
      certificate: cert,
      digestAlgorithm: forge.pki.oids['sha256'] ?? '2.16.840.1.101.3.4.2.1',
      authenticatedAttributes: [
        {
          type: forge.pki.oids['contentType'] ?? '1.2.840.113549.1.9.3',
          value: forge.pki.oids['data'] ?? '1.2.840.113549.1.7.1'
        },
        {
          type: forge.pki.oids['messageDigest'] ?? '1.2.840.113549.1.9.4'
        },
        {
          type: forge.pki.oids['signingTime'] ?? '1.2.840.113549.1.9.5',
          value: new Date() as any
        }
      ]
    } as any);

    // Envoltura con contenido embebido (equivalente a -nodetach en OpenSSL)
    p7.sign({ detached: false });

    const asn1 = p7.toAsn1();
    const der = forge.asn1.toDer(asn1).getBytes();

    return forge.util.encode64(der);
  }
}
