// LOAD: carga esperada sostenida (mezcla POS) — ¿cumple los SLO con el tráfico normal?
import { posMix, commonThresholds } from './lib.js';

export const options = {
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 40),
      timeUnit: '1s',
      duration: __ENV.DURATION || '3m',
      preAllocatedVUs: 100,
      maxVUs: 400
    }
  },
  thresholds: commonThresholds
};

export default posMix;
