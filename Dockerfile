# ==============================================================================
# Multi-stage Dockerfile para Producción: ARCA API
# ==============================================================================

# --- Etapa 1: Compilación de TypeScript ---
FROM node:22-alpine AS builder

WORKDIR /app

# Instalar dependencias de compilación
COPY package*.json tsconfig.json ./
RUN npm ci

# Copiar código fuente y compilar a JavaScript (dist/)
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY drizzle.config.ts ./
RUN npm run build

# --- Etapa 2: Imagen Final de Producción ---
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Instalar sólo dependencias de producción
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copiar artefactos compilados y migraciones
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

# Usuario sin privilegios por seguridad
USER node

EXPOSE 3000

# Healthcheck nativo
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health/live').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/app/bootstrap.js"]
