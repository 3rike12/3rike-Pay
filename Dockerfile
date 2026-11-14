# syntax=docker/dockerfile:1
# 3rike Pay API
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma needs OpenSSL on Alpine
RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY scripts/build.js ./scripts/build.js
COPY src ./src
RUN npm run build

# Keep the runtime image production-only without downloading the dependency
# tree a second time.
RUN npm prune --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY public ./public
# Prisma client generated files
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 3000

# prisma/schema.prisma is postgres, so `db push` creates tables
# in the compose postgres on first boot. Existing DBs are untouched.
CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
