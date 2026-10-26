# 🇦🇷 ARCA API — Facturación Electrónica AFIP / ARCA

[![Node.js](https://img.shields.io/badge/Node.js-22_LTS-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7_Strict-blue.svg)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.2-black.svg)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue.svg)](https://www.postgresql.org/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-0.39-green.svg)](https://orm.drizzle.team/)
[![Vitest](https://img.shields.io/badge/Vitest-102_Tests_Passing-brightgreen.svg)](https://vitest.dev/)
[![Docker & Dokploy](https://img.shields.io/badge/Deploy-Docker_%7C_Dokploy-blue.svg)](https://dokploy.com/)

API REST moderna, multi-tenant y de alto rendimiento para **Facturación Electrónica en Argentina**, integrada directamente con los servicios web oficiales de **ARCA** (ex AFIP): **WSAA**, **WSFEv1** y **Padrón A5**.

Diseñada bajo principios de **Clean Architecture**, alta concurrencia, resiliencia fiscal, criptografía segura y cero dependencias de plataformas intermediarias pagas.

---

## 🚀 Características Principales

### 🧾 Emisión de Comprobantes con CAE Oficial (WSFEv1)
* **Facturas:** Factura A (`1`), Factura B (`6`), Factura C (`11`), Factura M (`51`).
* **Notas de Débito:** ND A (`2`), ND B (`7`), ND C (`12`), ND M (`52`).
* **Notas de Crédito:** NC A (`3`), NC B (`8`), NC C (`13`), NC M (`53`).
* **Comprobantes Asociados:** Soporte reglamentario de referencias fiscales obligatorias para Notas de Crédito y Débito.
* **Conceptos:** Productos (`1`), Servicios (`2`) y Productos y Servicios (`3`) con fechas reglamentarias de vencimiento y servicio.
* **Condición IVA Receptor:** Compatible con la normativa actualizada de ARCA (`CondicionIVAReceptorId`).
* **Borradores (Drafts):** Creación y cálculo impositivo local preliminar sin consumir numeración fiscal en ARCA.

### 🔐 Autenticación Criptográfica Automática (WSAA)
* **Generación de CSR y Claves Privadas:** Creación asistida de par RSA 2048 y Certificate Signing Request (CSR) vía API.
* **Firma de CMS / PKCS#7:** Generación automática de Tickets de Requerimiento de Acceso (TRA) firmados criptográficamente.
* **Caché Inteligente de Tokens:** Almacenamiento y reutilización de tokens WSAA durante sus ~12 horas de validez con upsert atómico transaccional para evitar peticiones redundantes.
* **Cifrado en Reposo (AES-256-GCM):** Claves privadas protegidas en base de datos con vector de inicialización único (IV) y tag de autenticación.

### ⚡ Concurrencia y Resiliencia en Punto de Venta (POS)
* **FiscalLock (PostgreSQL Advisory Locks):** Previene condiciones de carrera y saltos de numeración cuando múltiples terminales de cobro emiten comprobantes en el mismo milisegundo.
* **Control de Idempotencia:** Cabecera `x-idempotency-key` para garantizar que un corte de conexión o reintento de red jamás genere facturas duplicadas ante ARCA.
* **Zona Horaria Oficial:** Fechas fiscales ancladas estrictamente a `America/Argentina/Buenos_Aires` para evitar desajustes en emisiones cercanas a medianoche.
* **Reconciliación Automática:** Endpoint `reconcile` que consulta `FECompConsultar` para recuperar el CAE de comprobantes pendientes tras caídas temporales de red.

### 🏢 Multi-Tenancy y Seguridad
* **Aislamiento Estricto por Comercio:** Cada comercio opera con sus propias API Keys sha256, roles (`admin`, `seller`), identidades fiscales y puntos de venta.
* **Clave Maestra de Plataforma:** Administración global protegida contra *Timing Attacks* mediante `crypto.timingSafeEqual`.
* **Rate Limiting:** Limitador de tasa configurable por IP y comercio.
* **CORS Configurable:** Restricción estricta de dominios para entornos de producción.

### 📄 Documentos y Representaciones Fiscales
* **PDF Oficial A4:** Generación de factura conforme a las Resoluciones Generales AFIP 1415 y 5003.
* **Ticket Térmico POS:** Formato optimizado para impresoras térmicas de 80mm y 58mm (ESC/POS).
* **Código QR Oficial RG 5003:** Generación en PNG y SVG listo para escanear y validar en el portal de ARCA.
* **Envío por Email:** Despacho automatizado del comprobante en PDF vía SMTP.

### 🔍 Padrón de Contribuyentes (ARCA A5)
* Consulta oficial de datos de contribuyentes en tiempo real por CUIT/DNI.
* Caché en memoria con cupo acotado (LRU bounded cache de 5.000 entradas) para alta velocidad de respuesta y protección de memoria RAM.

### 📊 Reportes y Auditoría
* **Libro IVA Ventas Digital:** Exportación en CSV listo para contabilidad y AFIP.
* **Resumen Diario:** Totales facturados, desglose de IVA por alícuota y cantidad de comprobantes por estado.
* **Registro de Auditoría:** Historial inmutable de operaciones fiscales y de seguridad.

---

## 🛠️ Stack Tecnológico

| Componente | Tecnología |
| :--- | :--- |
| **Runtime** | Node.js 22 LTS |
| **Lenguaje** | TypeScript 5.7 (Modo Estricto) |
| **Framework HTTP** | Fastify 5.2 |
| **Base de Datos** | PostgreSQL 16 |
| **ORM & Migraciones** | Drizzle ORM 0.39 + Drizzle Kit |
| **Criptografía** | OpenSSL / Node Crypto / Node Forge |
| **Validación de Esquemas** | TypeBox / Zod |
| **Documentación** | Swagger / OpenAPI 3.0 UI |
| **Testing** | Vitest (102 tests unitarios e integración) |
| **Contenedorización** | Docker (Alpine Multi-Stage) / Dokploy |

---

## 📋 Requisitos Previos

* **Node.js** 20.x o 22.x LTS instalado.
* **PostgreSQL** 15 o 16 en ejecución.
* **Certificado X.509 y Clave Privada** emitidos por ARCA (para operar en ambiente de homologación o producción).

---

## ⚙️ Instalación y Configuración

### 1. Clonar el Repositorio
```bash
git clone https://github.com/tu-usuario/arca-api.git
cd arca-api
```

### 2. Instalar Dependencias
```bash
npm install
```

### 3. Configurar Variables de Entorno
Copia el archivo de ejemplo y ajusta tus valores:
```bash
cp .env.example .env
```

#### Descripción de Variables de Entorno:

| Variable | Tipo | Por defecto | Descripción |
| :--- | :---: | :---: | :--- |
| `PORT` | Número | `3000` | Puerto HTTP en el que escuchará la API. |
| `HOST` | String | `0.0.0.0` | Dirección de enlace de red (`0.0.0.0` para Docker/VPS). |
| `NODE_ENV` | String | `development` | Entorno de ejecución: `development`, `test` o `production`. |
| `LOG_LEVEL` | String | `info` | Nivel de logs de Pino: `fatal`, `error`, `warn`, `info`, `debug`. |
| `CORS_ORIGIN` | String | `*` | Orígenes autorizados en producción (ej: `https://pos.midominio.com`). |
| `DATABASE_URL` | URL | - | Cadena de conexión PostgreSQL (`postgres://user:pass@host:5432/db`). |
| `DATABASE_MAX_CONNECTIONS` | Número | `10` | Conexiones máximas simultáneas en el pool de PostgreSQL. |
| `DATABASE_STATEMENT_TIMEOUT_MS`| Número | `10000` | Límite máximo de espera para consultas SQL (10s por defecto). |
| `API_KEY_MASTER` | String | - | **Clave Maestra de Plataforma**. En producción debe ser un secreto criptográfico de al menos 32 caracteres para crear comercios (Tenants). |
| `ENCRYPTION_KEY` | Hex (64) | - | Clave de 32 bytes (64 caracteres hex) para cifrado en reposo con **AES-256-GCM** de las claves privadas. Generar con: `openssl rand -hex 32`. |
| `ARCA_DEFAULT_ENVIRONMENT` | Enum | `homologation` | **Ambiente fiscal predeterminado**: `homologation` (servidores de prueba de AFIP sin valor legal) o `production` (emisión real con validez fiscal ante ARCA). |
| `ARCA_PLATFORM_CUIT` | String (11) | `20000000001` | **CUIT emisor de la plataforma o comercio raíz** (11 dígitos numéricos sin guiones, ej. `20111111112`). En homologación se usa el CUIT con el que se solicitó el acceso en WSASS; en producción, el CUIT del contribuyente titular. |
| `RATE_LIMIT_MAX` | Número | `300` | Peticiones máximas permitidas por ventana de tiempo. |
| `RATE_LIMIT_WINDOW_MS` | Número | `60000` | Ventana de tiempo del limitador de tasa en milisegundos (1 minuto). |

> 💡 **Guía de configuración para variables de ARCA:**
> * **`ARCA_DEFAULT_ENVIRONMENT`**:
>   * `homologation` *(Recomendado para pruebas)*: Conecta con los entornos de prueba y certificación de AFIP (`wsaahomo.afip.gov.ar`, `wswhomo.afip.gov.ar`). Las facturas y CAE emitidos **NO tienen validez fiscal** ni impacto impositivo.
>   * `production` *(Solo cuando salgas a producción)*: Conecta con los servidores oficiales en vivo de ARCA (`wsaa.afip.gov.ar`, `servicios1.afip.gov.ar`). Cada factura emitida tiene plena validez legal y fiscal.
> * **`ARCA_PLATFORM_CUIT`**:
>   * Cadena de **11 dígitos numéricos** sin guiones ni espacios (ej: `20111111112`).
>   * En **Homologación**: Puedes dejar el valor predeterminado `20000000001` (CUIT de prueba de AFIP) o usar tu propio CUIT si tramitaste el alias en WSASS.
>   * En **Producción**: Coloca el **CUIT real del titular o empresa administradora** que opera la plataforma.


### 4. Ejecutar Migraciones de Base de Datos
```bash
npm run db:migrate
```

### 5. Iniciar en Modo Desarrollo
```bash
npm run dev
```

La API estará disponible en `http://localhost:3000`.  
La documentación interactiva Swagger estará en `http://localhost:3000/documentation`.

---

## 🚢 Despliegue en Producción (Docker & Dokploy)

El proyecto incluye un `Dockerfile` multi-stage optimizado sobre Alpine Linux y un `docker-compose.prod.yml` listo para desplegar con **Dokploy**, **Portainer** o **Docker Compose**.

### Despliegue con Docker Compose
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Despliegue en Dokploy
1. Crea una aplicación de tipo **Compose** en Dokploy.
2. Pega el contenido de `docker-compose.prod.yml`.
3. En la pestaña **Domains**: selecciona el servicio `api` y el puerto interno `3000`.
4. En la pestaña **Environment**: configura tus credenciales de producción (`API_KEY_MASTER`, `ENCRYPTION_KEY`, `ARCA_DEFAULT_ENVIRONMENT=production`, `ARCA_PLATFORM_CUIT=tu_cuit`).
5. Presiona **Deploy**. El contenedor ejecutará automáticamente las migraciones de base de datos al iniciar.

---

## 🔐 Flujo Completo: De Contenedor Limpio a Facturación en Vivo

Este es el flujo cronológico que debes seguir una vez que levantes el contenedor de la API (en Dokploy, Docker o local):

```
┌────────────────────────────────────────────────────────────────────────┐
│ PASO 1: CREAR EL COMERCIO (TENANT) CON TU API_KEY_MASTER               │
│ - Endpoint: POST /api/v1/tenants                                       │
│ - Header: x-api-key: <API_KEY_MASTER>                                  │
│ - Recibes: El ID del comercio y su API Key propia ("com_sec_...")       │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PASO 2: REGISTRAR LA IDENTIDAD FISCAL (CUIT DEL COMERCIO)              │
│ - Endpoint: POST /api/v1/fiscal-identities                             │
│ - Header: x-api-key: <TU_API_KEY_DE_COMERCIO>                          │
│ - Body: { cuit: "20111111112", businessName: "...", environment: ... } │
│ - Recibes: fiscalIdentityId (UUID) en estado PENDING_CERTIFICATE       │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PASO 3: GENERAR LA SOLICITUD DE CERTIFICADO (CSR) DESDE LA API         │
│ - Endpoint: POST /api/v1/fiscal-identities/:id/certificate-requests    │
│ - Header: x-api-key: <TU_API_KEY_DE_COMERCIO>                          │
│ - La API crea el par RSA 2048, cifra la clave privada con AES-256-GCM  │
│   en PostgreSQL y te entrega el texto csrPem (.csr)                    │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PASO 4: TRAMITAR EL CERTIFICADO (.crt) EN EL PORTAL DE AFIP / ARCA     │
│                                                                        │
│ • En Homologación (Pruebas):                                           │
│   1. Entrar con Clave Fiscal a https://www.afip.gob.ar                 │
│   2. Abrir servicio "WSASS - Autoservicio de Acceso a Web Services"    │
│   3. "Crear Computador Fiscal" -> Elegir alias (ej: postesting)        │
│   4. Pegar el csrPem -> Descargar certificado (.crt)                   │
│   5. "Autorización a Servicios" -> Autorizar alias en "wsfe" y         │
│      "ws_sr_constancia_inscripcion" (Consulta Constancia Inscripción)   │
│                                                                        │
│ • En Producción (Real):                                                │
│   1. Entrar a AFIP con Clave Fiscal Nivel 3 o superior                 │
│   2. Abrir servicio "Administración de Certificados Digitales"         │
│   3. "Agregar Alias" (ej: pos-prod) -> Subir archivo .csr              │
│   4. Descargar certificado oficial emitido (.crt)                      │
│   5. Abrir "Administrador de Relaciones de Clave Fiscal"               │
│      -> "Nueva Relación" -> "AFIP" -> "WebServices"                    │
│      -> "Facturación Electrónica" (wsfe) -> Asociar alias pos-prod     │
│      -> "WS Padrón - Consulta Constancia Inscripción"                  │
│         (ws_sr_constancia_inscripcion) -> Asociar alias pos-prod       │
│   6. Abrir "Administración de Puntos de Venta y Domicilios"            │
│      -> Dar de alta un Punto de Venta tipo "Factura Electrónica - WS"   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PASO 5: SUBIR EL CERTIFICADO (.crt) A LA API                           │
│ - Endpoint: POST /api/v1/fiscal-identities/:id/certificates            │
│ - Header: x-api-key: <TU_API_KEY_DE_COMERCIO>                          │
│ - Body: { certificatePem: "-----BEGIN CERTIFICATE-----\n..." }         │
│ - La API valida criptográficamente la correspondencia con la clave     │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PASO 6: PROBAR CONEXIÓN Y DETECTAR PUNTOS DE VENTA AUTOMÁTICAMENTE     │
│ - Endpoint: POST /api/v1/fiscal-identities/:id/connection-tests        │
│ - Header: x-api-key: <TU_API_KEY_DE_COMERCIO>                          │
│ - La API autentica ante WSAA, consulta WSFEv1, sincroniza Puntos de    │
│   Venta y deja la identidad fiscal en estado CONNECTED ✅               │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PASO 7: FACTURAR DESDE TU POS CON CAE OFICIAL                          │
│ - Endpoint: POST /api/v1/invoices                                      │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Detalle de Peticiones HTTP del Asistente

#### 1. Crear el Comercio (Tenant) y su API Key

**A. Crear el Comercio:**
```bash
curl -X POST http://localhost:3000/api/v1/tenants \
  -H "x-api-key: <TU_API_KEY_MASTER>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Mi Supermercado",
    "slug": "mi-supermercado"
  }'
```
*Respuesta (201 Created):*
```json
{
  "id": "c1f7a240-5e3a-4a67-b501-8b7a421189aa",
  "name": "Mi Supermercado",
  "slug": "mi-supermercado",
  "active": true,
  "createdAt": "2026-10-25T00:00:00.000Z"
}
```

**B. Generar la API Key para el POS:**
Con el `id` obtenido del paso anterior:
```bash
curl -X POST http://localhost:3000/api/v1/tenants/c1f7a240-5e3a-4a67-b501-8b7a421189aa/api-keys \
  -H "x-api-key: <TU_API_KEY_MASTER>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "POS Principal",
    "role": "pos_client"
  }'
```
*Respuesta (201 Created):*
```json
{
  "id": "e2d3b4c5-...",
  "tenantId": "c1f7a240-5e3a-4a67-b501-8b7a421189aa",
  "name": "POS Principal",
  "prefix": "live_sec_...",
  "role": "pos_client",
  "rawKey": "live_sec_a8f9c1e2d345b6789...",
  "createdAt": "2026-10-25T00:00:00.000Z"
}
```
> ⚠️ **Guarda el `rawKey`:** Esta es la clave de comercio (`<TU_API_KEY_DE_COMERCIO>`) que configurás en tu POS para emitir facturas y administrar identidades fiscales. Solo se muestra una única vez al crearla.

---

#### 2. Registrar la Identidad Fiscal
```bash
curl -X POST http://localhost:3000/api/v1/fiscal-identities \
  -H "x-api-key: <TU_API_KEY_DE_COMERCIO>" \
  -H "Content-Type: application/json" \
  -d '{
    "cuit": "20111111112",
    "businessName": "Mi Supermercado SRL",
    "environment": "homologation",
    "taxCondition": "RESPONSABLE_INSCRIPTO"
  }'
```
*Respuesta (201 Created):*
```json
{
  "id": "f58a72b1-6a2c-4912-8bb4-098845112233",
  "cuit": "20111111112",
  "businessName": "Mi Supermercado SRL",
  "environment": "homologation",
  "status": "PENDING_CERTIFICATE"
}
```

---

#### 3. Generar el CSR (Certificate Signing Request)
```bash
curl -X POST http://localhost:3000/api/v1/fiscal-identities/f58a72b1-6a2c-4912-8bb4-098845112233/certificate-requests \
  -H "x-api-key: <TU_API_KEY_DE_COMERCIO>"
```
*Respuesta (201 Created):*
```json
{
  "fiscalIdentityId": "f58a72b1-6a2c-4912-8bb4-098845112233",
  "cuit": "20111111112",
  "csrPem": "-----BEGIN CERTIFICATE REQUEST-----\nMIICvDCCAaQCAQAwdzELMAkGA1UEBhMCQVIxEzARBgNVBAgMCkJ1ZW5vcyBBaXJl\n...\n-----END CERTIFICATE REQUEST-----",
  "instructions": "Subir este CSR al portal de AFIP (WSASS en homologación o Certificados Digitales en producción)..."
}
```

---

#### 4. Cargar el Certificado (.crt) Emitido por ARCA
Una vez obtenido el certificado en el portal de AFIP, envíalo en formato PEM:
```bash
curl -X POST http://localhost:3000/api/v1/fiscal-identities/f58a72b1-6a2c-4912-8bb4-098845112233/certificates \
  -H "x-api-key: <TU_API_KEY_DE_COMERCIO>" \
  -H "Content-Type: application/json" \
  -d '{
    "certificatePem": "-----BEGIN CERTIFICATE-----\nMIIDSjCCAjKgAwIBAgIIXitC+dKtxfkwDQYJKoZIhvcNAQENBQAwODEaMBgGA1UE\n...\n-----END CERTIFICATE-----"
  }'
```
*Respuesta (200 OK):*
```json
{
  "message": "Certificado cargado y validado correctamente.",
  "metadata": {
    "validFrom": "2026-10-25T00:00:00.000Z",
    "validTo": "2028-10-25T23:59:59.000Z",
    "subject": "CN=Mi Supermercado SRL, C=AR, SERIALNUMBER=CUIT 20111111112",
    "isExpired": false
  }
}
```

---

#### 5. Probar Conexión y Sincronizar Puntos de Venta
```bash
curl -X POST http://localhost:3000/api/v1/fiscal-identities/f58a72b1-6a2c-4912-8bb4-098845112233/connection-tests \
  -H "x-api-key: <TU_API_KEY_DE_COMERCIO>"
```
*Respuesta (200 OK):*
```json
{
  "ok": true,
  "status": "CONNECTED",
  "message": "Conexión con WSAA y WSFEv1 establecida con éxito. Puntos de venta sincronizados.",
  "puntosVenta": [
    { "nro": 1, "emisionTipo": "CAE", "bloqueado": false }
  ]
}
```

---

## 📖 Emisión de Facturas y Comprobantes (API)

---

### 3. Emitir Factura B (Consumidor Final)
```bash
curl -X POST http://localhost:3000/api/v1/invoices \
  -H "x-api-key: <TU_API_KEY>" \
  -H "x-idempotency-key: pos-venta-uuid-1001" \
  -H "Content-Type: application/json" \
  -d '{
    "fiscalIdentityId": "uuid-de-la-identidad",
    "pointOfSaleNumber": 1,
    "voucherType": 6,
    "concept": 1,
    "pricesIncludeVat": true,
    "customer": {
      "docType": 99,
      "docNumber": "0",
      "name": "Consumidor Final",
      "taxCondition": 5
    },
    "items": [
      {
        "description": "Café Colombiano 500g",
        "quantity": 2,
        "unitPrice": 4500,
        "vatRate": 21
      }
    ]
  }'
```

*Respuesta Exitosa (201 Created):*
```json
{
  "id": "e674512b-...",
  "status": "AUTHORIZED",
  "voucherType": 6,
  "pointOfSaleNumber": 1,
  "voucherNumber": 104,
  "cae": "74421234567890",
  "caeExpiresAt": "2026-11-04T02:59:59.000Z",
  "totalAmount": "9000.00",
  "vatAmount": "1561.98",
  "netTaxedAmount": "7438.02",
  "qrData": "https://www.afip.gob.ar/fe/qr/?p=eyJ2ZXIiOjEs..."
}
```

---

### 4. Emitir Nota de Crédito B (Anulación o Devolución)
Exige incluir el comprobante original en `associatedVouchers`:
```bash
curl -X POST http://localhost:3000/api/v1/invoices \
  -H "x-api-key: <TU_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "fiscalIdentityId": "uuid-de-la-identidad",
    "pointOfSaleNumber": 1,
    "voucherType": 8,
    "associatedVouchers": [
      {
        "voucherType": 6,
        "pointOfSale": 1,
        "voucherNumber": 104
      }
    ],
    "customer": {
      "docType": 99,
      "docNumber": "0",
      "name": "Consumidor Final"
    },
    "items": [
      {
        "description": "Devolución Café Colombiano 500g",
        "quantity": 1,
        "unitPrice": 4500,
        "vatRate": 21
      }
    ]
  }'
```

---

### 5. Descargar Documentos Fiscales
* **PDF A4 Oficial:**
  ```bash
  curl -O -J -H "x-api-key: <TU_API_KEY>" http://localhost:3000/api/v1/documents/<INVOICE_ID>/pdf
  ```
* **Ticket Térmico (ESC/POS 80mm):**
  ```bash
  curl -H "x-api-key: <TU_API_KEY>" "http://localhost:3000/api/v1/documents/<INVOICE_ID>/thermal?width=80"
  ```
* **Código QR AFIP RG 5003:**
  ```bash
  curl -H "x-api-key: <TU_API_KEY>" "http://localhost:3000/api/v1/documents/<INVOICE_ID>/qr?format=png"
  ```

---

### 6. Consultar Padrón ARCA A5 en Tiempo Real
```bash
curl -H "x-api-key: <TU_API_KEY>" http://localhost:3000/api/v1/taxpayers/30503612891
```

---

## 🧪 Pruebas Automatizadas

El proyecto cuenta con una cobertura integral de pruebas unitarias e integración con mocks SOAP y base de datos real:

```bash
# Ejecutar toda la suite de pruebas
npm test

# Modo interactivo / observador
npm run test:watch

# Cobertura de código
npm run test:coverage
```

**Resultados:**
* 24 suites de prueba passing (`24 passed`).
* 102 tests automáticos passing (`102 passed`).

---

## 📁 Estructura del Proyecto

```
arca-api/
├── drizzle/                    # Migraciones SQL generadas por Drizzle
├── src/
│   ├── app/                    # Servidor Fastify, configuración y logger
│   │   ├── bootstrap.ts        # Punto de entrada y auto-migración
│   │   ├── config.ts           # Validación estricta con Zod
│   │   └── server.ts           # Registro de plugins y rutas
│   ├── core/                   # Núcleo de lógica transversal y fiscal
│   │   ├── errors/             # Jerarquía de errores tipados
│   │   ├── fiscal/             # Validadores (Módulo 11 CUIT, catálogos, impuestos)
│   │   └── security/           # FiscalLock, AES-256-GCM, Idempotencia, API Keys
│   ├── infrastructure/         # Base de datos PostgreSQL y schemas Drizzle
│   │   └── database/schema/    # Tablas: tenants, invoices, vouchers, tickets, etc.
│   └── modules/                # Módulos de dominio y aplicación
│       ├── arca/               # Clientes SOAP: WSAA, WSFEv1, Padrón A5
│       ├── audit/              # Trazabilidad y logs de auditoría
│       ├── customers/          # Clientes comerciales y validación fiscal
│       ├── documents/          # Generadores de PDF, ticket térmico y QR
│       ├── fiscal-identities/  # Gestión de certificados X.509 y puntos de venta
│       ├── invoices/           # Casos de uso de facturación y CAE
│       ├── notifications/      # Servicio de correo SMTP
│       ├── products/           # Catálogo de productos e IVA AFIP
│       ├── reports/            # Libro IVA Ventas y resúmenes diarios
│       ├── taxpayers/          # Consultas al Padrón A5 y caché LRU
│       └── tenants/            # Aislamiento multi-tenant y credenciales
├── tests/                      # Pruebas unitarias y de integración
├── docker-compose.prod.yml     # Compose para despliegue en producción / Dokploy
├── Dockerfile                  # Multi-stage Dockerfile sobre Alpine Linux
└── README.md                   # Documentación oficial
```

---

## 📄 Licencia

Este proyecto se distribuye bajo la licencia **MIT**. Puedes utilizarlo libremente tanto para proyectos personales como comerciales.
