// ENDPOINTS CAROS: reportes y libro IVA sin paginar sobre un comercio con muchos comprobantes.
// Pocos usuarios concurrentes alcanzan para saturar el pool de la base (ataque de "DoS de aplicación").
import { get } from './lib.js';

export const options = {
  scenarios: {
    heavy: { executor: 'constant-vus', vus: Number(__ENV.VUS || 10), duration: __ENV.DURATION || '1m' }
  }
};

export default function () {
  const r = Math.random();
  if (r < 0.5) get('/api/v1/reports/vat-sales-ledger', 'GET /reports/vat-sales-ledger');
  else if (r < 0.8) get('/api/v1/reports/sales', 'GET /reports/sales');
  else get('/api/v1/invoices?limit=100', 'GET /invoices?limit=100');
}
