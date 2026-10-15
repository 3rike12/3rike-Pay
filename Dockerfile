# 3rike Pay API
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma needs OpenSSL on Alpine
RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
# Prisma client generated files
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 3000

# prisma/schema.prisma is postgres, so `db push` creates tables
# in the compose postgres on first boot. Existing DBs are untouched.
CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
