#!/usr/bin/env bash
# Ejecuta un escenario k6 contra el entorno de pruebas de carga y muestrea CPU/RAM de los contenedores.
#   loadtest/run-k6.sh load            (capacity | load | stress | spike | soak | emission-hotspot | cross-tenant-starvation | heavy-endpoints)
#   RATE=80 DURATION=5m loadtest/run-k6.sh load
# Si PROM_RW_URL está definido, las métricas se envían a Prometheus (remote write) para verlas en Grafana.
set -euo pipefail
cd "$(dirname "$0")"
name="$1"; shift || true
mkdir -p results

stats="results/docker-stats-${name}.csv"
echo "ts,container,cpu,mem" > "$stats"
( while true; do
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' arca-loadtest-api-1 arca-loadtest-postgres-1 2>/dev/null \
      | sed "s/^/$(date +%s),/" >> "$stats" || true
    sleep 2
  done ) &
sampler=$!
trap 'kill $sampler 2>/dev/null || true' EXIT

denv=(); kout=()
if [[ -n "${PROM_RW_URL:-}" ]]; then
  denv=(-e K6_PROMETHEUS_RW_SERVER_URL="$PROM_RW_URL" -e K6_PROMETHEUS_RW_TREND_STATS='p(50),p(95),p(99),avg,max')
  kout=(-o experimental-prometheus-rw)
fi

MSYS_NO_PATHCONV=1 docker run --rm -i \
  -v "$(pwd -W 2>/dev/null || pwd)/k6:/scripts:ro" \
  -v "$(pwd -W 2>/dev/null || pwd)/results:/results" \
  -e MODE -e STEPS -e STEP_SECONDS -e SPREAD -e RATE -e DURATION -e VUS -e POS -e PEAK -e BASE_URL \
  "${denv[@]}" \
  grafana/k6:1.3.0 run "${kout[@]}" --quiet --tag testid="arca-${name}" \
  --summary-export "/results/k6-${name}.json" "/scripts/${name}.js" "$@" 2>&1 | tee "results/k6-${name}.txt" || true

curl -s http://localhost:3419/ > "results/arca-mock-after-${name}.json" || true
