// SPIKE: salto repentino (p. ej. apertura de todas las cajas / Black Friday) y vuelta a la normalidad
import { posMix } from './lib.js';

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 300,
      maxVUs: 3000,
      stages: [
        { target: 10, duration: '30s' },
        { target: Number(__ENV.PEAK || 600), duration: '10s' },
        { target: Number(__ENV.PEAK || 600), duration: '40s' },
        { target: 10, duration: '10s' },
        { target: 10, duration: '1m' }
      ]
    }
  }
};

export default posMix;
