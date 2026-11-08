// HOTSPOT FISCAL: N cajas emitiendo en el MISMO punto de venta. La numeración de ARCA es secuencial,
// así que la API serializa con un lock por (CUIT, PtoVta, Tipo): mide el techo de emisión y la cola.
import { emitInvoice } from './lib.js';

export const options = {
  scenarios: {
    hotspot: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 20),
      duration: __ENV.DURATION || '2m'
    }
  }
};

export default function () {
  emitInvoice(Number(__ENV.POS || 9));
}
