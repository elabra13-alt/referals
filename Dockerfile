# syntax=docker/dockerfile:1

# ---------- Stage 1: builder — compile TypeScript with dev dependencies ----------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 2: runner — production dependencies + compiled output only ----------
FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Root-owned and read-only for the runtime user: a compromised process can't rewrite the app.
COPY --from=builder /app/dist ./dist
# Migrations are read from ./drizzle relative to WORKDIR by dist/db/migrate.js.
COPY drizzle ./drizzle

USER node
EXPOSE 3000

# Default: Run pending database migrations, then start the API.
# The escrow worker service overrides this with `node dist/worker.js`.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/server.js"]
