# syntax=docker/dockerfile:1
# 3rike Pay API (+ the web app it serves)
#
# Three build stages. `web` and `api` do not depend on each other, so BuildKit builds them AT THE SAME TIME
# instead of one after the other (the web install and Vite build are the slowest steps).
#
#   docker build .                              the production image
#   docker build --target web-typecheck .       type-check the web app (not part of the image build; run it in CI)

# Node 24 ships npm 11, which web/package-lock.json needs, so there is no `npm install -g npm@11` step.
# The web app also requires Node 22 or later.
FROM node:24-alpine AS base
WORKDIR /app
# Prisma needs OpenSSL on Alpine
RUN apk add --no-cache openssl libc6-compat

# ---- web: install and build, independent of the API ----
FROM base AS web
# Vite bundles the wallet libraries (several thousand modules); give Node room so it does not thrash the GC.
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY web/package.json web/package-lock.json ./web/
RUN --mount=type=cache,target=/root/.npm npm --prefix web ci --include=dev --no-audit --no-fund
COPY web ./web
# Straight to the bundler: the type-check is its own target (web-typecheck), not a second pass here.
RUN npm --prefix web run build:bundle

# Not built unless asked for: `docker build --target web-typecheck .`
FROM web AS web-typecheck
RUN npm --prefix web run typecheck

# ---- api: install, generate the Prisma client, compile, then drop dev dependencies ----
FROM base AS api
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Keep the runtime image production-only without downloading the dependency tree a second time.
RUN npm prune --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json ./
COPY --from=api /app/node_modules ./node_modules

COPY --from=api /app/dist ./dist
COPY --from=web /app/web/dist ./web/dist
COPY --from=api /app/prisma ./prisma
COPY public ./public
# Prisma client generated files
COPY --from=api /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 3000

# prisma/schema.prisma is postgres, so `db push` creates tables
# in the compose postgres on first boot. Existing DBs are untouched.
CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
