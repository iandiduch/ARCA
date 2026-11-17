import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Datos del pedido HTTP en curso que la auditoría necesita y que los services no reciben:
 * la IP de origen y la API Key que autenticó. Se abre en `onRequest`, se retoma en `preValidation`
 * (el parseo del body corre en callbacks del socket y pierde el contexto) y `authenticate`
 * completa `apiKeyId`. Fuera de un pedido (cron, scripts) no hay contexto.
 */
export interface RequestContext {
  ip?: string | undefined;
  apiKeyId?: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();
const byRequest = new WeakMap<object, RequestContext>();

export function openRequestContext(request: object, ctx: RequestContext, done: () => void): void {
  byRequest.set(request, ctx);
  storage.run(ctx, done);
}

export function resumeRequestContext(request: object, done: () => void): void {
  const ctx = byRequest.get(request);
  if (ctx) storage.run(ctx, done);
  else done();
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
