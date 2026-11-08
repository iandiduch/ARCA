# Pruebas de carga y capacidad

Cuánto aguanta **una sola réplica** de la API con los recursos de [`docker-compose.prod.yml`](../docker-compose.prod.yml),
cómo se comporta cuando se la satura y cómo repetir las mediciones.

Todo corre contra un entorno aislado ([`docker-compose.yml`](docker-compose.yml)): la imagen de producción de la API +
PostgreSQL 16, con ARCA (WSAA / WSFEv1 / Padrón) reemplazado por un simulador en memoria
([`harness/start.mjs`](harness/start.mjs)). **Nunca se contactan los servidores reales de ARCA**, y estas pruebas no deben
apuntarse a una instalación de producción.

## Resultados (noviembre 2026)

**Entorno medido**

| | |
|---|---|
| API | 1 réplica, límite 2 vCPU / 1 GB (igual que `docker-compose.prod.yml`) |
| PostgreSQL 16 | límite 1 vCPU / 1 GB (igual que `docker-compose.prod.yml`), pool de 20 conexiones |
| Datos | ~96.000 comprobantes, 70.000 de un mismo comercio |
| ARCA simulado | 150–450 ms por llamada (la latencia real de ARCA suele ser mayor, ver más abajo) |
| Carga | k6 1.3, escalones de 1 minuto a tasa constante, rate limit desactivado para medir la capacidad bruta |

### Resumen

| Tipo de tráfico | Rápido y sin errores hasta | Techo de la réplica | Primer cuello de botella |
|---|---|---|---|
| Sólo lecturas (listados, detalle, búsqueda de productos y clientes) | **~400 req/s** (p95 53 ms) | ~500 req/s | Postgres (1 vCPU) y el hilo de Node |
| Sólo emisión de facturas (2 comercios, 10 puntos de venta cada uno) | **~10 facturas/s** (p95 0,5 s) | ~20 facturas/s | Límite por comercio (diseño, ver abajo) |
| Mezcla realista (75 % lecturas, 15 % emisiones, 10 % reporte del día) | **~200 req/s** (lecturas p95 126 ms, emisión p95 0,9 s) | ~260 req/s | Postgres (1 vCPU) |

Como referencia: 200 req/s de esa mezcla son ~15 facturas por segundo, unas **54.000 facturas por hora** con una sola réplica.

### Lecturas

| req/s pedidas | req/s logradas | p50 | p95 | p99 | errores |
|---|---|---|---|---|---|
| 100 | 100 | 5 ms | 8 ms | 11 ms | 0 % |
| 200 | 200 | 5 ms | 7 ms | 17 ms | 0 % |
| 400 | 400 | 5 ms | 53 ms | 182 ms | 0 % |
| 600 | 504 | 5,2 s | 8,1 s | 8,2 s | 0,4 % |
| 800 | 508 | 5,3 s | 9,8 s | 28 s | 0,6 % |
| 1200 | 515 | 4,8 s | 8,7 s | 20 s | 3,4 % |

Por encima de ~500 req/s la réplica no procesa más: las peticiones se encolan y la latencia sube a segundos.

### Emisión

| facturas/s pedidas | autorizadas/s | p50 | p95 | p99 | 429 por límite de comercio |
|---|---|---|---|---|---|
| 5 | 5,0 | 340 ms | 477 ms | 577 ms | 0 % |
| 10 | 10,0 | 360 ms | 546 ms | 699 ms | 0 % |
| 15 | 14,6 | 348 ms | 601 ms | 794 ms | 2,6 % |
| 20 | 17,6 | 349 ms | 646 ms | 860 ms | 11,8 % |
| 30 | 20,4 | 292 ms | 700 ms | 905 ms | 31,9 % |

7.397 facturas autorizadas en esta corrida, sin ninguna fuera de secuencia. La CPU de la API no pasó del 57 % ni la de
Postgres del 39 %.

Cada comercio puede tener como máximo **5 emisiones en curso a la vez** (`MAX_IN_FLIGHT_EMISSIONS_PER_TENANT`). Lo que
excede ese límite se rechaza al instante con **429 y `Retry-After`**, en lugar de quedar esperando: así un comercio que
satura no le quita capacidad a los demás. Por eso, con 2 comercios el techo es ~20 facturas/s, y crece con la cantidad
de comercios activos, no con el hardware. La API casi no consume CPU emitiendo: el tiempo se va en esperar a ARCA.

**Con ARCA real** la latencia suele estar entre 0,5 y 1,5 s por comprobante, así que el techo realista **por comercio** es
de **3 a 10 facturas por segundo**. Un mismo punto de venta numera en orden (ARCA lo exige), así que también emite de a
uno: entre 1 y 3 facturas por segundo por punto de venta.

### Mezcla realista

| req/s pedidas | req/s logradas | lecturas p95 | emisión p95 | facturas/s | 429 por límite de comercio |
|---|---|---|---|---|---|
| 50 | 50 | 10 ms | 0,7 s | 7,4 | 0 % |
| 100 | 100 | 11 ms | 0,6 s | 13,9 | 1,3 % |
| 150 | 150 | 20 ms | 0,7 s | 17,2 | 3,5 % |
| 200 | 200 | 126 ms | 0,9 s | 16,5 | 6,9 % |
| 300 | 262 | 13,2 s | 16,8 s | 0,5 | 15 % |

Hasta 200 req/s todos los errores son 429 del límite por comercio (2 comercios emitiendo 15 facturas/s cada uno). A
300 req/s Postgres llega al 100 % de su vCPU y todo se encola.

### Comportamiento ante saturación

En todas las corridas, incluso al doble de la capacidad:

- La API **no se cayó ni se reinició**, y no hubo errores de falta de memoria (pico de 245 MiB de RAM sobre 1 GB).
- **No hubo numeración duplicada ni salteada**: el simulador de ARCA no recibió ninguna solicitud fuera de secuencia.
- Al bajar la carga se **recupera sola** en segundos: `/health/ready` respondió enseguida al terminar cada escalón.
- Lo que no entra se rechaza con 429 (emisiones de un comercio saturado) o espera en cola; no hay respuestas 500.

### Mejora encontrada con estas pruebas

Las tablas `invoice_items`, `invoice_vat_subtotals` e `invoice_associated_vouchers` no tenían índice por `invoice_id`:
cada lectura de un comprobante recorría la tabla entera (7.000 millones de filas leídas en una hora de pruebas). Con la
migración `0011` la mezcla realista pasó de degradarse a partir de **~50 req/s a ~200 req/s**.

## Cuándo escalar

1. **Más CPU para Postgres.** Es el primer límite en casi todos los escenarios (1 vCPU en `docker-compose.prod.yml`).
   Pasarlo a 2 vCPU es lo más barato y lo primero que conviene hacer.
2. **Más réplicas de la API.** Cuando la API pasa del ~70 % de CPU de forma sostenida o el p95 de lecturas supera los
   500 ms. Ver [Escalar a varias réplicas](../README.md#escalar-a-varias-réplicas) en el README.

La cantidad de facturas por comercio no se aumenta con hardware: depende de la latencia de ARCA y de
`MAX_IN_FLIGHT_EMISSIONS_PER_TENANT`.

## Cómo repetir las pruebas

Requisitos: Docker y bash (en Windows, Git Bash).

```bash
# 1. Levantar el entorno (rate limit desactivado para medir capacidad)
RATE_LIMIT_MAX=100000000 docker compose -f loadtest/docker-compose.yml -p arca-loadtest up -d --build

# 2. Capacidad por escalones
MODE=reads bash loadtest/run-k6.sh capacity      # 100 → 1200 req/s de lecturas
MODE=emit  bash loadtest/run-k6.sh capacity      # 5 → 30 facturas/s
MODE=mix   bash loadtest/run-k6.sh capacity      # 50 → 300 req/s de mezcla realista
node loadtest/summarize.mjs loadtest/results/k6-capacity.json   # tabla por escalón de la última corrida

# Escalones a medida: STEPS=150,250,350 STEP_SECONDS=120 MODE=mix bash loadtest/run-k6.sh capacity

# 3. Otros escenarios
RATE=40 DURATION=3m bash loadtest/run-k6.sh load              # carga sostenida
bash loadtest/run-k6.sh stress                                # rampa 20 → 800 req/s y recuperación
PEAK=600 bash loadtest/run-k6.sh spike                        # pico repentino
VUS=20 POS=9 bash loadtest/run-k6.sh emission-hotspot         # muchas cajas en el mismo punto de venta
VUS=30 bash loadtest/run-k6.sh cross-tenant-starvation        # un comercio satura y otro intenta facturar
VUS=10 bash loadtest/run-k6.sh heavy-endpoints                # reportes y Libro IVA
RATE=25 DURATION=24h bash loadtest/run-k6.sh soak             # resistencia (fugas de memoria / conexiones)

# 4. Bajar el entorno y borrar sus datos
docker compose -f loadtest/docker-compose.yml -p arca-loadtest down -v
```

- API de prueba: `http://localhost:3410` · estado del simulador ARCA: `http://localhost:3419` · Postgres: `localhost:55433`.
- Cada arranque crea dos comercios (A y B, 10 puntos de venta cada uno) con API keys de todos los roles y las escribe en
  `loadtest/results/seed.json`.
- Cada corrida deja en `loadtest/results/` el resumen de k6 (`k6-<escenario>.json` / `.txt`), CPU y RAM de los
  contenedores cada 2 s (`docker-stats-<escenario>.csv`) y el estado del simulador de ARCA.
- La latencia del simulador se ajusta con `ARCA_MOCK_LATENCY_MIN_MS` / `ARCA_MOCK_LATENCY_MAX_MS` (por ejemplo 500 y
  1500 para acercarse a ARCA real), y `ARCA_MOCK_LOST_RESPONSE_RATE=0.3` hace que ARCA autorice pero la respuesta se
  pierda, para probar la conciliación.
- Los resultados dependen del hardware: k6 corre en la misma máquina que la API, así que conviene repetirlos en el
  servidor donde se va a desplegar.
