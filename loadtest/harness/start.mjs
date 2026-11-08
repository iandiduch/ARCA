// Arranque de la API para pruebas de carga: reemplaza ARCA por un simulador en memoria, siembra datos y luego
// ejecuta el bootstrap real (dist/app/bootstrap.js). Sólo para entornos de prueba.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/app/package.json');
const forge = require('node-forge');

const dist = (p) => import(`/app/dist/${p}`);
const { Wsfev1Client } = await dist('modules/arca/infrastructure/wsfev1/wsfev1-client.js');
const { WsaaClient } = await dist('modules/arca/infrastructure/wsaa/wsaa-client.js');
const { PadronClient } = await dist('modules/arca/infrastructure/padron/padron-client.js');
const { runMigrations } = await dist('infrastructure/database/migrate.js');
const { getDatabase } = await dist('infrastructure/database/connection.js');
const schema = await dist('infrastructure/database/schema/index.js');
const { generateApiKey } = await dist('core/security/api-key.js');
const { EncryptionService } = await dist('core/security/encryption.js');

// ---------------------------------------------------------------------------
// Simulador ARCA
// ---------------------------------------------------------------------------
const MIN = Number(process.env.ARCA_MOCK_LATENCY_MIN_MS ?? 150);
const MAX = Number(process.env.ARCA_MOCK_LATENCY_MAX_MS ?? 450);
const LOST_RATE = Number(process.env.ARCA_MOCK_LOST_RESPONSE_RATE ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const latency = () => sleep(MIN + Math.random() * (MAX - MIN));

/** key cuit:ptoVta:tipo → { last, records: Map<nro, record> } */
const sequences = new Map();
const seq = (cuit, ptoVta, tipo) => {
  const k = `${cuit}:${ptoVta}:${tipo}`;
  if (!sequences.has(k)) sequences.set(k, { last: 0, records: new Map() });
  return sequences.get(k);
};
/** Controles de prueba: GET :9999/?failNext=N (pierde las próximas N respuestas autorizadas)
 *  y ?bump=cuit:pto:tipo&n=K (otro sistema autoriza K comprobantes en esa secuencia) */
const control = { failNext: 0, failUltimoNext: 0, foreignBeforeNext: null, foreignAgoSec: 0, dropNext: 0 };
const stats = { solicitarCae: 0, authorized: 0, rejected: 0, lost: 0, outOfSequence: 0 };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
// FchProceso de WSFEv1: yyyymmddhhmmss en hora argentina (UTC-3)
const fchProceso = (d = new Date()) => new Date(d.getTime() - 3 * 3600000).toISOString().replace(/\D/g, '').slice(0, 14);

Wsfev1Client.dummy = async () => {
  await latency();
  return { appServer: 'OK', dbServer: 'OK', authServer: 'OK' };
};
Wsfev1Client.getUltimoComprobante = async (auth, ptoVta, tipo) => {
  await latency();
  if (control.failUltimoNext > 0) {
    control.failUltimoNext--;
    throw new Error('ETIMEDOUT simulado (forzado): FECompUltimoAutorizado');
  }
  return seq(auth.cuit, ptoVta, tipo).last;
};
Wsfev1Client.getPuntosVenta = async () => {
  await latency();
  return Array.from({ length: 10 }, (_, i) => ({ nro: i + 1, emisionTipo: 'CAE', bloqueado: 'N', fchBaja: 'NULL' }));
};
Wsfev1Client.solicitarCae = async (auth, req) => {
  stats.solicitarCae++;
  await latency();
  const s = seq(auth.cuit, req.ptoVta, req.cbteTipo);
  const d = req.detalle;
  if (control.foreignBeforeNext !== null) {
    // Otro sistema autoriza el siguiente número justo antes de que llegue esta solicitud
    s.last++;
    // Venta de otro sistema con los mismos importes que haría la API para ese total (Factura B, IVA 21 %)
    const t = control.foreignBeforeNext;
    const neto = round2(t / 1.21);
    s.records.set(s.last, { cae: '68888888888888', caeFchVto: '20991231', cbteFch: d.cbteFch, impTotal: t, impNeto: neto, impIVA: round2(t - neto), docTipo: 99, docNro: 0, fchProceso: fchProceso(new Date(Date.now() - control.foreignAgoSec * 1000)) });
    control.foreignBeforeNext = null;
    control.foreignAgoSec = 0;
  }
  if (control.dropNext > 0) {
    // La solicitud se pierde antes de que ARCA la procese (timeout sin respuesta)
    control.dropNext--;
    stats.lost++;
    throw new Error('ETIMEDOUT simulado (forzado): solicitud no procesada');
  }
  const errores = [];
  // Reglas que ARCA valida realmente sobre la cabecera (no ve los ítems)
  if (d.cbteDesde !== s.last + 1) {
    stats.outOfSequence++;
    errores.push({ code: 10016, message: `El numero o fecha del comprobante no se corresponde con el proximo a autorizar (${s.last + 1})` });
  }
  const sum = round2((d.impTotConc ?? 0) + (d.impNeto ?? 0) + (d.impOpEx ?? 0) + (d.impTrib ?? 0) + (d.impIVA ?? 0));
  if (Math.abs(sum - d.impTotal) > 0.01) {
    errores.push({ code: 10048, message: 'ImpTotal debe ser igual a la suma de ImpTotConc + ImpNeto + ImpOpEx + ImpTrib + ImpIVA' });
  }
  if (d.impTotal < 0 || d.impNeto < 0 || d.impIVA < 0) {
    errores.push({ code: 10017, message: 'Los importes no pueden ser negativos' });
  }
  const base = { observaciones: [], eventos: [], xmlRequest: '<mock-request/>', xmlResponse: '<mock-response/>' };
  if (errores.length) {
    stats.rejected++;
    return { ...base, resultado: 'R', errores, cbteDesde: d.cbteDesde, cbteHasta: d.cbteHasta };
  }
  s.last = d.cbteDesde;
  const cae = String(70000000000000 + Math.floor(Math.random() * 9999999999999));
  const record = { cae, caeFchVto: yyyymmdd(new Date(Date.now() + 10 * 86400000)), cbteFch: d.cbteFch, impTotal: d.impTotal, impNeto: d.impNeto, impIVA: d.impIVA, docTipo: d.docTipo, docNro: d.docNro, fchProceso: fchProceso() };
  s.records.set(d.cbteDesde, record);
  stats.authorized++;
  if (control.failNext > 0) {
    control.failNext--;
    stats.lost++;
    throw new Error('ETIMEDOUT simulado (forzado): respuesta de FECAESolicitar perdida');
  }
  if (Math.random() < LOST_RATE) {
    // ARCA autorizó pero la respuesta se pierde en la red (caso más peligroso para duplicación)
    stats.lost++;
    throw new Error('ETIMEDOUT simulado: respuesta de FECAESolicitar perdida');
  }
  return { ...base, resultado: 'A', errores: [], cae, caeFchVto: record.caeFchVto, cbteDesde: d.cbteDesde, cbteHasta: d.cbteHasta, cbteFch: d.cbteFch };
};
Wsfev1Client.consultarComprobante = async (auth, ptoVta, tipo, nro) => {
  await latency();
  const r = seq(auth.cuit, ptoVta, tipo).records.get(nro);
  if (!r) return { encontrado: false, errores: [{ code: 602, message: 'Sin Resultados' }], observaciones: [] };
  return { encontrado: true, resultado: 'A', cbteDesde: nro, cbteHasta: nro, ...r, errores: [], observaciones: [] };
};
// WSAA: conserva la lectura de caché en base (como en producción) pero no firma ni llama a ARCA
const originalFindCached = WsaaClient.findCachedTicket.bind(WsaaClient);
WsaaClient.getTicket = async (fiscalIdentityId, _pk, _cert, options) => {
  await originalFindCached(fiscalIdentityId, options?.service ?? 'wsfe', options?.environment ?? 'homologation');
  return { token: 'mock-token', sign: 'mock-sign', expirationTime: new Date(Date.now() + 12 * 3600000), fromCache: true };
};
if (PadronClient?.getPersona) {
  PadronClient.getPersona = async (_a, cuit) => {
    await latency();
    return { cuit: String(cuit), nombre: 'CONTRIBUYENTE SIMULADO', tipoPersona: 'FISICA', estadoClave: 'ACTIVO' };
  };
}
globalThis.__arcaMockStats = stats;
globalThis.__arcaMockSequences = sequences;

// ---------------------------------------------------------------------------
// Siembra de datos
// ---------------------------------------------------------------------------
await runMigrations();
const db = getDatabase();
const run = Date.now().toString(36);

const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
const pkPem = forge.pki.privateKeyToPem(keys.privateKey);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date(Date.now() - 3600000);
cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
cert.setSubject([{ name: 'commonName', value: 'audit' }]);
cert.sign(keys.privateKey, forge.md.sha256.create());
const certPem = forge.pki.certificateToPem(cert);

async function makeKey(tenantId, role, extra = {}) {
  const k = generateApiKey('test');
  const [row] = await db
    .insert(schema.apiKeys)
    .values({ tenantId, name: `audit-${role}`, prefix: k.prefix, keyHash: k.keyHash, role, ...extra })
    .returning();
  return { id: row.id, raw: k.rawKey };
}

async function makeTenant(label, cuit, posCount) {
  const [t] = await db.insert(schema.tenants).values({ name: `Audit ${label}`, slug: `audit-${label}-${run}` }).returning();
  const enc = EncryptionService.encrypt(pkPem);
  const [fi] = await db
    .insert(schema.fiscalIdentities)
    .values({ tenantId: t.id, cuit, businessName: `Audit ${label} SRL`, status: 'CONNECTED', environment: 'homologation', taxCondition: 'RESPONSABLE_INSCRIPTO' })
    .returning();
  await db.insert(schema.fiscalCertificates).values({
    fiscalIdentityId: fi.id,
    encryptedPrivateKey: enc.ciphertext,
    privateKeyIv: enc.iv,
    privateKeyAuthTag: enc.authTag,
    certificate: certPem,
    certificateFingerprint: crypto.createHash('sha256').update(certPem).digest('hex'),
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    active: true
  });
  for (let n = 1; n <= posCount; n++) {
    await db.insert(schema.pointsOfSale).values({ fiscalIdentityId: fi.id, number: n, type: 'ELECTRONIC', active: true });
  }
  return { tenantId: t.id, fiscalIdentityId: fi.id, cuit };
}

const A = await makeTenant('a', '30712345675', 10);
const B = await makeTenant('b', '20223626719', 10);
const seed = {
  baseUrl: 'http://localhost:3410',
  master: process.env.API_KEY_MASTER,
  A: {
    ...A,
    admin: await makeKey(A.tenantId, 'admin'),
    pos: await makeKey(A.tenantId, 'pos_client'),
    readOnly: await makeKey(A.tenantId, 'read_only'),
    expired: await makeKey(A.tenantId, 'pos_client', { expiresAt: new Date(Date.now() - 60000) }),
    revoked: await makeKey(A.tenantId, 'pos_client', { active: false })
  },
  B: { ...B, admin: await makeKey(B.tenantId, 'admin'), pos: await makeKey(B.tenantId, 'pos_client') }
};
fs.writeFileSync('/out/seed.json', JSON.stringify(seed, null, 2));
console.log('[loadtest-harness] seed escrito en /out/seed.json');

// Endpoint interno del simulador (puerto aparte, sólo dentro del contenedor + mapeo opcional)
const http = await import('node:http');
http
  .createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    if (q.has('failNext')) control.failNext = Number(q.get('failNext'));
    if (q.has('foreign')) control.foreignBeforeNext = Number(q.get('foreign'));
    if (q.has('foreignAgo')) control.foreignAgoSec = Number(q.get('foreignAgo')); // segundos antes de nuestra solicitud
    if (q.has('dropNext')) control.dropNext = Number(q.get('dropNext'));
    if (q.has('failUltimoNext')) control.failUltimoNext = Number(q.get('failUltimoNext'));
    if (q.has('bump')) {
      const [c, p, t] = q.get('bump').split(':');
      const s = seq(c, Number(p), Number(t));
      for (let i = 0; i < Number(q.get('n') ?? 1); i++) {
        s.last++;
        s.records.set(s.last, { cae: '69999999999999', caeFchVto: '20991231', cbteFch: '20261108', impTotal: 1, impNeto: 1, impIVA: 0, docTipo: 99, docNro: 0 });
      }
    }
    const seqs = Object.fromEntries([...sequences].map(([k, v]) => [k, { last: v.last, authorized: v.records.size }]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ stats, sequences: seqs, memory: process.memoryUsage() }));
  })
  .listen(9999, '0.0.0.0');

await import('/app/dist/app/bootstrap.js');
