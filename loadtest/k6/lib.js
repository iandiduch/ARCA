// Utilidades compartidas por los escenarios k6 de la API ARCA
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

export const seed = JSON.parse(open('/results/seed.json'));
export const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3410';
export const A = seed.A;

export const emitted = new Counter('invoices_authorized');
export const emitBusy = new Counter('invoices_busy_429_503');
export const emitLatency = new Trend('emit_latency', true);
export const readLatency = new Trend('read_latency', true);

const headers = (key, extra = {}) => ({ 'content-type': 'application/json', 'x-api-key': key, ...extra });

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function emitInvoice(pos, key = A.pos.raw) {
  const items = Array.from({ length: 1 + Math.floor(Math.random() * 6) }, (_, i) => ({
    description: `Artículo ${i}`,
    quantity: 1 + Math.floor(Math.random() * 5),
    unitPrice: Math.round(Math.random() * 50000) / 100 + 1,
    vatRate: i % 3 === 0 ? 10.5 : 21
  }));
  const body = JSON.stringify({ fiscalIdentityId: A.fiscalIdentityId, pointOfSaleNumber: pos, voucherType: 6, items, posSaleId: uuid() });
  const res = http.post(`${BASE}/api/v1/invoices`, body, {
    headers: headers(key, { 'x-idempotency-key': uuid() }),
    tags: { name: 'POST /invoices' },
    timeout: '60s'
  });
  emitLatency.add(res.timings.duration);
  if (res.status === 201) emitted.add(1);
  if (res.status === 503 || res.status === 429) emitBusy.add(1);
  check(res, { 'emit 201': (r) => r.status === 201 });
  return res;
}

export function get(path, name, key = A.readOnly.raw) {
  const res = http.get(`${BASE}${path}`, { headers: headers(key), tags: { name } });
  readLatency.add(res.timings.duration);
  check(res, { [`${name} 200`]: (r) => r.status === 200 });
  return res;
}

/** Mezcla realista de un POS: mayoría de lecturas, ~25 % emisiones, algún PDF */
export function posMix() {
  const r = Math.random();
  if (r < 0.25) {
    const res = emitInvoice(1 + Math.floor(Math.random() * 10));
    if (res.status === 201 && Math.random() < 0.2) {
      get(`/api/v1/invoices/${res.json('id')}/pdf`, 'GET /invoices/:id/pdf');
    }
  } else if (r < 0.5) {
    get('/api/v1/invoices?limit=20', 'GET /invoices');
  } else if (r < 0.75) {
    get(`/api/v1/products?search=art&limit=20`, 'GET /products?search');
  } else if (r < 0.9) {
    get('/api/v1/customers?limit=20', 'GET /customers');
  } else {
    get('/api/v1/reports/sales', 'GET /reports/sales');
  }
}

export const commonThresholds = {
  http_req_failed: ['rate<0.01'],
  'http_req_duration{name:GET /invoices}': ['p(95)<500'],
  emit_latency: ['p(95)<2000']
};
