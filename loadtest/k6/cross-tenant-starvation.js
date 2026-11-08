// AISLAMIENTO DE CAPACIDAD ENTRE COMERCIOS: el comercio A satura un único punto de venta (muchas cajas, o un
// cliente malicioso con su propia key) mientras el comercio B emite a ritmo normal en el suyo.
// Si la latencia/errores de B se degradan, un comercio puede dejar sin facturación a toda la plataforma.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { emitInvoice, seed, BASE, uuid } from './lib.js';

const victimLatency = new Trend('victim_emit_latency', true);
const victimFail = new Counter('victim_emit_failed');

export const options = {
  scenarios: {
    baseline: { executor: 'constant-arrival-rate', exec: 'victim', rate: 1, timeUnit: '2s', duration: '30s', preAllocatedVUs: 5, maxVUs: 50, tags: { phase: 'baseline' } },
    attacker: { executor: 'constant-vus', exec: 'attacker', vus: Number(__ENV.VUS || 30), duration: '90s', startTime: '30s', tags: { phase: 'attack' } },
    underAttack: { executor: 'constant-arrival-rate', exec: 'victim', rate: 1, timeUnit: '2s', duration: '80s', startTime: '40s', preAllocatedVUs: 5, maxVUs: 100, tags: { phase: 'attack' } }
  },
  thresholds: {
    'victim_emit_latency{phase:baseline}': ['p(95)<3000'],
    'victim_emit_latency{phase:attack}': ['p(95)<3000']
  }
};

export function attacker() {
  // SPREAD=1: A reparte la carga en sus 10 PtoVta; si no, todas al mismo PtoVta
  emitInvoice(__ENV.SPREAD ? 1 + Math.floor(Math.random() * 10) : 9);
}

export function victim() {
  const B = seed.B;
  const body = JSON.stringify({ fiscalIdentityId: B.fiscalIdentityId, pointOfSaleNumber: 1, voucherType: 6, items: [{ description: 'venta B', quantity: 1, unitPrice: 121 }] });
  const res = http.post(`${BASE}/api/v1/invoices`, body, {
    headers: { 'content-type': 'application/json', 'x-api-key': B.pos.raw, 'x-idempotency-key': uuid() },
    timeout: '60s',
    tags: { name: 'B POST /invoices' }
  });
  victimLatency.add(res.timings.duration);
  if (res.status !== 201) victimFail.add(1);
  check(res, { 'B emit 201': (r) => r.status === 201 });
}
