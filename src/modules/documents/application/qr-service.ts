import QRCode from 'qrcode';

export class QrService {
  /**
   * Genera una imagen PNG del código QR como Buffer
   */
  public static async generatePngBuffer(qrData: string, width: number = 200): Promise<Buffer> {
    return QRCode.toBuffer(qrData, {
      type: 'png',
      width,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
  }

  /**
   * Genera un Data URL en Base64 ('data:image/png;base64,...') para incrustar en HTML o imágenes
   */
  public static async generateDataUrl(qrData: string, width: number = 200): Promise<string> {
    return QRCode.toDataURL(qrData, {
      width,
      margin: 1,
      errorCorrectionLevel: 'M'
    });
  }

  /**
   * Genera el código QR en formato vectorial SVG
   */
  public static async generateSvg(qrData: string, width: number = 200): Promise<string> {
    return QRCode.toString(qrData, {
      type: 'svg',
      width,
      margin: 1,
      errorCorrectionLevel: 'M'
    });
  }
}
