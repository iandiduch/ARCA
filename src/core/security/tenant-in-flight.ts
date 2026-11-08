/**
 * Gestor en proceso de límite de emisiones simultáneas en vuelo por comercio (tenant).
 * Evita que un comercio sature la plataforma o consuma todas las conexiones de emisión.
 */
export class TenantInFlightLimiter {
  private static inFlightMap = new Map<string, number>();

  /**
   * Intenta reservar un slot de emisión para el tenant.
   * Retorna true si se concedió, o false si ya alcanzó el máximo permitido.
   */
  public static tryAcquire(tenantId: string, maxInFlight: number): boolean {
    const current = this.inFlightMap.get(tenantId) ?? 0;
    if (current >= maxInFlight) {
      return false;
    }
    this.inFlightMap.set(tenantId, current + 1);
    return true;
  }

  /**
   * Libera un slot de emisión previamente reservado.
   */
  public static release(tenantId: string): void {
    const current = this.inFlightMap.get(tenantId) ?? 0;
    if (current <= 1) {
      this.inFlightMap.delete(tenantId);
    } else {
      this.inFlightMap.set(tenantId, current - 1);
    }
  }

  /**
   * Retorna la cantidad de emisiones actualmente en vuelo para el tenant.
   */
  public static getInFlight(tenantId: string): number {
    return this.inFlightMap.get(tenantId) ?? 0;
  }

  /**
   * Reinicia los contadores (útil en tests).
   */
  public static reset(): void {
    this.inFlightMap.clear();
  }
}

