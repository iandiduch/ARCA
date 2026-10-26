import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PadronClient } from '../../src/modules/arca/infrastructure/padron/padron-client.js';
import { NotFoundError, FiscalError } from '../../src/core/errors/app-error.js';

describe('PadronClient - Consulta de Constancia de Inscripción (v2)', () => {
  const dummyAuth = {
    token: 'test-token',
    sign: 'test-sign',
    cuit: '20301234567'
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Debe parsear contribuyente Responsable Inscripto con getPersona_v2Response', async () => {
    const mockXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getPersona_v2Response xmlns="http://a5.soap.ws.server.puc.sr/">
      <personaReturn>
        <datosGenerales>
          <razonSocial>ACME SOCIEDAD ANONIMA</razonSocial>
          <tipoPersona>JURIDICA</tipoPersona>
          <estadoClave>ACTIVO</estadoClave>
          <domicilioFiscal>
            <direccion>Av. Corrientes 1234</direccion>
            <localidad>CABA</localidad>
            <descripcionProvincia>Ciudad Autónoma de Buenos Aires</descripcionProvincia>
            <codPostal>1043</codPostal>
          </domicilioFiscal>
        </datosGenerales>
        <datosRegimenGeneral>
          <impuesto>
            <idImpuesto>30</idImpuesto>
            <descripcionImpuesto>IVA</descripcionImpuesto>
          </impuesto>
          <impuesto>
            <idImpuesto>10</idImpuesto>
            <descripcionImpuesto>GANANCIAS SOCIEDADES</descripcionImpuesto>
          </impuesto>
        </datosRegimenGeneral>
      </personaReturn>
    </getPersona_v2Response>
  </soap:Body>
</soap:Envelope>`;

    // @ts-expect-error accessing private static method for testing
    vi.spyOn(PadronClient, 'executeSoap').mockResolvedValue(mockXml);

    const result = await PadronClient.getPersona(dummyAuth, '30712345678');

    expect(result.cuit).toBe('30712345678');
    expect(result.businessName).toBe('ACME SOCIEDAD ANONIMA');
    expect(result.personType).toBe('JURIDICA');
    expect(result.fiscalCondition).toBe('IVA_RESPONSABLE_INSCRIPTO');
    expect(result.fiscalConditionCode).toBe(1);
    expect(result.address?.street).toBe('Av. Corrientes 1234');
    expect(result.address?.city).toBe('CABA');
  });

  it('2. Debe parsear contribuyente Monotributista con datosMonotributo y categoría', async () => {
    const mockXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getPersona_v2Response xmlns="http://a5.soap.ws.server.puc.sr/">
      <personaReturn>
        <datosGenerales>
          <apellido>PEREZ</apellido>
          <nombre>JUAN CARLOS</nombre>
          <tipoPersona>FISICA</tipoPersona>
          <estadoClave>ACTIVO</estadoClave>
        </datosGenerales>
        <datosMonotributo>
          <categoriaMonotributo>
            <descripcionCategoria>C</descripcionCategoria>
            <idCategoria>3</idCategoria>
          </categoriaMonotributo>
          <impuesto>
            <idImpuesto>20</idImpuesto>
            <descripcionImpuesto>MONOTRIBUTO</descripcionImpuesto>
          </impuesto>
        </datosMonotributo>
      </personaReturn>
    </getPersona_v2Response>
  </soap:Body>
</soap:Envelope>`;

    // @ts-expect-error accessing private static method for testing
    vi.spyOn(PadronClient, 'executeSoap').mockResolvedValue(mockXml);

    const result = await PadronClient.getPersona(dummyAuth, '20301112223');

    expect(result.cuit).toBe('20301112223');
    expect(result.businessName).toBe('PEREZ JUAN CARLOS');
    expect(result.personType).toBe('FISICA');
    expect(result.fiscalCondition).toBe('RESPONSABLE_MONOTRIBUTO');
    expect(result.fiscalConditionCode).toBe(6);
  });

  it('3. Debe parsear contribuyente IVA Exento', async () => {
    const mockXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getPersona_v2Response xmlns="http://a5.soap.ws.server.puc.sr/">
      <personaReturn>
        <datosGenerales>
          <razonSocial>FUNDACION SOLIDARIA</razonSocial>
          <tipoPersona>JURIDICA</tipoPersona>
          <estadoClave>ACTIVO</estadoClave>
        </datosGenerales>
        <datosRegimenGeneral>
          <impuesto>
            <idImpuesto>33</idImpuesto>
            <descripcionImpuesto>IVA EXENTO</descripcionImpuesto>
          </impuesto>
        </datosRegimenGeneral>
      </personaReturn>
    </getPersona_v2Response>
  </soap:Body>
</soap:Envelope>`;

    // @ts-expect-error accessing private static method for testing
    vi.spyOn(PadronClient, 'executeSoap').mockResolvedValue(mockXml);

    const result = await PadronClient.getPersona(dummyAuth, '30554433221');

    expect(result.fiscalCondition).toBe('IVA_EXENTO');
    expect(result.fiscalConditionCode).toBe(4);
  });

  it('4. Debe lanzar NotFoundError si errorConstancia indica que no existe persona', async () => {
    const mockXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getPersona_v2Response xmlns="http://a5.soap.ws.server.puc.sr/">
      <personaReturn>
        <errorConstancia>No existe persona con ese identificador</errorConstancia>
      </personaReturn>
    </getPersona_v2Response>
  </soap:Body>
</soap:Envelope>`;

    // @ts-expect-error accessing private static method for testing
    vi.spyOn(PadronClient, 'executeSoap').mockResolvedValue(mockXml);

    await expect(PadronClient.getPersona(dummyAuth, '20999999999')).rejects.toThrow(NotFoundError);
  });

  it('5. Debe lanzar NotFoundError si soap:Fault indica que no existe persona', async () => {
    const mockXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Server</faultcode>
      <faultstring>No existe persona con ese identificador</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;

    // @ts-expect-error accessing private static method for testing
    vi.spyOn(PadronClient, 'executeSoap').mockResolvedValue(mockXml);

    await expect(PadronClient.getPersona(dummyAuth, '20999999999')).rejects.toThrow(NotFoundError);
  });

  it('6. Debe lanzar FiscalError en caso de otro error informado por ARCA', async () => {
    const mockXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getPersona_v2Response xmlns="http://a5.soap.ws.server.puc.sr/">
      <personaReturn>
        <errorConstancia>La clave consultada se encuentra bloqueada por fiscalización</errorConstancia>
      </personaReturn>
    </getPersona_v2Response>
  </soap:Body>
</soap:Envelope>`;

    // @ts-expect-error accessing private static method for testing
    vi.spyOn(PadronClient, 'executeSoap').mockResolvedValue(mockXml);

    await expect(PadronClient.getPersona(dummyAuth, '20301112223')).rejects.toThrow(FiscalError);
  });
});
