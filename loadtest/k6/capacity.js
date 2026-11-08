// CAPACIDAD DE UNA RÉPLICA: escalones de carga constante (1 min cada uno, uno detrás de otro) para encontrar
// hasta dónde la API responde rápido y sin errores. MODE=reads | emit | mix.
//   MODE=reads STEPS=100,200,400 loadtest/run-k6.sh capacity
// Cada escalón es un escenario (r100, r200, ...): el resumen trae p95 y tasa de error por escalón.
import http from 'k6/http';
import { A, emitInvoice, emitted, emitBusy, emitLatency, get, seed, uuid, BASE } from './lib.js';

const MODE = __ENV.MODE || 'reads';
const DEFAULT_STEPS = { reads: '100,200,400,600,800,1000,1200', emit: '5,10,15,20,30', mix: '50,100,150,200,300' };
const STEPS = (__ENV.STEPS || DEFAULT_STEPS[MODE]).split(',').map(Number);
const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 60);
const GAP = 10; // segundos de pausa entre escalones para que se vacíen las colas

const scenarios = {};
const thresholds = {};
STEPS.forEach((rate, i) => {
  const name = `${MODE[0]}${rate}`;
  scenarios[name] = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration: `${STEP_SECONDS}s`,
    startTime: `${i * (STEP_SECONDS + GAP)}s`,
    preAllocatedVUs: Math.min(rate * 2, 1500),
    maxVUs: 3000,
    exec: MODE
  };
  // Umbrales "siempre verdaderos": sólo fuerzan a k6 a exportar las métricas de cada escalón
  for (const m of ['http_req_duration', 'http_req_failed', 'read_latency', 'emit_latency', 'invoices_authorized', 'invoices_busy_429_503', 'iterations', 'dropped_iterations']) {
    thresholds[`${m}{scenario:${name}}`] = m === 'http_req_failed' ? ['rate<=1'] : m.startsWith('invoices') || m.endsWith('iterations') ? ['count>=0'] : ['p(95)>=0'];
  }
});

export const options = { scenarios, thresholds, summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'] };

export function setup() {
  const res = http.get(`${BASE}/api/v1/invoices?limit=100`, {
    headers: { 'x-api-key': A.readOnly.raw },
    timeout: '60s'
  });
  return { ids: (res.json('data') || []).map((i) => i.id) };
}

/** Lecturas típicas de un POS: listado, detalle, búsqueda de productos y clientes */
export function reads(data) {
  const invoiceIds = data.ids;
  const r = Math.random();
  if (r < 0.3) get('/api/v1/invoices?limit=20', 'GET /invoices');
  else if (r < 0.55 && invoiceIds.length) get(`/api/v1/invoices/${invoiceIds[Math.floor(Math.random() * invoiceIds.length)]}`, 'GET /invoices/:id');
  else if (r < 0.85) get('/api/v1/products?search=art&limit=20', 'GET /products?search');
  else get('/api/v1/customers?limit=20', 'GET /customers');
}

/** Emisiones repartidas entre los dos comercios sembrados y 10 puntos de venta cada uno */
export function emit() {
  const tenant = Math.random() < 0.5 ? seed.A : seed.B;
  emitInvoiceFor(tenant, 1 + Math.floor(Math.random() * 10));
}

/** Mezcla realista: 75 % lecturas, 15 % emisiones, 10 % reportes del día */
export function mix(data) {
  const r = Math.random();
  if (r < 0.15) emit();
  else if (r < 0.25) get(`/api/v1/reports/sales?fromDate=${today()}&toDate=${today()}`, 'GET /reports/sales (día)');
  else reads(data);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emitInvoiceFor(tenant, pos) {
  if (tenant === seed.A) return emitInvoice(pos, A.pos.raw);
  // Comercio B: mismo cuerpo que emitInvoice pero con su identidad fiscal
  const body = JSON.stringify({
    fiscalIdentityId: tenant.fiscalIdentityId,
    pointOfSaleNumber: pos,
    voucherType: 6,
    posSaleId: uuid(),
    items: [{ description: 'Artículo', quantity: 1 + Math.floor(Math.random() * 3), unitPrice: 1 + Math.round(Math.random() * 50000) / 100, vatRate: 21 }]
  });
  return emitRaw(body, tenant.pos.raw);
}

function emitRaw(body, key) {
  const res = http.post(`${BASE}/api/v1/invoices`, body, {
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-idempotency-key': uuid() },
    tags: { name: 'POST /invoices' },
    timeout: '60s'
  });
  emitLatency.add(res.timings.duration);
  if (res.status === 201) emitted.add(1);
  if (res.status === 503 || res.status === 429) emitBusy.add(1);
  return res;
}
