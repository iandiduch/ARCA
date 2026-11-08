// Resume una corrida de `capacity`: una fila por escalón con req/s logradas, latencias y errores.
//   node loadtest/summarize.mjs loadtest/results/k6-capacity.json
import fs from 'node:fs';

const file = process.argv[2] ?? new URL('./results/k6-capacity.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const metrics = JSON.parse(fs.readFileSync(file, 'utf8')).metrics;
const stepSeconds = Number(process.env.STEP_SECONDS ?? 60);

const steps = [...new Set(Object.keys(metrics).map((k) => k.match(/scenario:(\w+)/)?.[1]).filter(Boolean))].sort(
  (a, b) => Number(a.slice(1)) - Number(b.slice(1))
);
const m = (name, step, field) => metrics[`${name}{scenario:${step}}`]?.[field] ?? 0;

console.table(
  steps.map((s) => ({
    escalón: s,
    'req/s logradas': Math.round(m('iterations', s, 'count') / stepSeconds),
    'p50 ms': Math.round(m('http_req_duration', s, 'med')),
    'p95 ms': Math.round(m('http_req_duration', s, 'p(95)')),
    'lecturas p95 ms': Math.round(m('read_latency', s, 'p(95)')),
    'emisión p95 ms': Math.round(m('emit_latency', s, 'p(95)')),
    'error %': +(100 * m('http_req_failed', s, 'value')).toFixed(2),
    'facturas/s': +(m('invoices_authorized', s, 'count') / stepSeconds).toFixed(1),
    '429/503': m('invoices_busy_429_503', s, 'count'),
    'no enviadas': m('dropped_iterations', s, 'count')
  }))
);
