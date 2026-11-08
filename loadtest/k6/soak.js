// SOAK: carga moderada prolongada para detectar fugas de memoria / conexiones (ajustar DURATION, p. ej. 24h)
import { posMix, commonThresholds } from './lib.js';

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 25),
      timeUnit: '1s',
      duration: __ENV.DURATION || '15m',
      preAllocatedVUs: 50,
      maxVUs: 300
    }
  },
  thresholds: commonThresholds
};

export default posMix;
