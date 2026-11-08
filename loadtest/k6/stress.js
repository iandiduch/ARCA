// STRESS: rampa progresiva más allá de la capacidad para encontrar el punto de quiebre y ver la recuperación
import { posMix } from './lib.js';

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [
        { target: 50, duration: '1m' },
        { target: 100, duration: '1m' },
        { target: 200, duration: '1m' },
        { target: 400, duration: '1m' },
        { target: 800, duration: '1m' },
        { target: 20, duration: '1m' } // recuperación
      ]
    }
  },
  thresholds: { http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: false }] }
};

export default posMix;
