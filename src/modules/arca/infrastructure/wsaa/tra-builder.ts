export interface TraOptions {
  service?: string;
  skewMinutes?: number; // Minutos hacia atrás para evitar clock skew (default 10)
  ttlMinutes?: number; // Minutos de validez solicitados (default 600 = 10 horas)
}

export class TraBuilder {
  /**
   * Genera el XML del Ticket de Requerimiento de Acceso (TRA) requerido por WSAA.
   */
  public static build(options?: TraOptions): { xml: string; uniqueId: number } {
    const service = options?.service ?? 'wsfe';
    const skewMinutes = options?.skewMinutes ?? 10;
    const ttlMinutes = options?.ttlMinutes ?? 600;

    const now = Date.now();
    const uniqueId = Math.floor(now / 1000);

    const generationDate = new Date(now - skewMinutes * 60 * 1000);
    const expirationDate = new Date(now + ttlMinutes * 60 * 1000);

    const genTimeStr = this.formatIsoDate(generationDate);
    const expTimeStr = this.formatIsoDate(expirationDate);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${genTimeStr}</generationTime>
    <expirationTime>${expTimeStr}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`.trim();

    return { xml, uniqueId };
  }

  private static formatIsoDate(date: Date): string {
    // Formato ISO 8601 estándar con offset horario o UTC
    return date.toISOString();
  }
}
