import { describe, it, expect, afterEach, vi } from 'vitest';
import { Wsfev1Client, extractSoapFault, xmlEscape } from '../../src/modules/arca/infrastructure/wsfev1/wsfev1-client.js';

const fault = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>Server was unable to read request. ---&gt; There is an error in XML document (1, 400).</faultstring></soap:Fault></soap:Body></soap:Envelope>`;

describe('WSFEv1: manejo de SOAP Fault', () => {
  afterEach(() => vi.restoreAllMocks());

  it('extrae el faultstring', () => {
    expect(extractSoapFault(fault)).toContain('Server was unable to read request');
    expect(extractSoapFault('<soap:Envelope><soap:Body><FEDummyResponse/></soap:Body></soap:Envelope>')).toBeUndefined();
  });

  it('propaga el mensaje del fault cuando ARCA responde HTTP 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(fault, { status: 500 }));
    await expect(
      Wsfev1Client.getUltimoComprobante({ token: 't', sign: 's', cuit: '20301234567' }, 1, 6)
    ).rejects.toMatchObject({ code: 'ARCA_SOAP_FAULT', message: expect.stringContaining('unable to read request') });
  });

  it('escapa valores interpolados en el XML', () => {
    expect(xmlEscape(`a<b>&"c'`)).toBe('a&lt;b&gt;&amp;&quot;c&apos;');
    expect(xmlEscape(20301234567)).toBe('20301234567');
  });

  it('interpreta FchBaja "NULL" como punto de venta vigente', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEParamGetPtosVentaResult><ResultGet><PtoVenta><Nro>1</Nro><EmisionTipo>CAE - RECE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta><PtoVenta><Nro>2</Nro><EmisionTipo>CAE - RECE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>20250101</FchBaja></PtoVenta></ResultGet></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse></soap:Body></soap:Envelope>`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(xml, { status: 200 }));
    const ptos = await Wsfev1Client.getPuntosVenta({ token: 't', sign: 's', cuit: '20301234567' });
    expect(ptos[0]!.fchBaja).toBeUndefined();
    expect(ptos[1]!.fchBaja).toBe('20250101');
  });
});
