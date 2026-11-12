# 3rike Pay: crypto invoicing on NEAR Intents

> **NEAR Hackathon submission, track: Real-World Money (`realworld`).**

**What it is.** A merchant creates an invoice (from WhatsApp, or the demo script below). Their customer opens a pay link and pays from **any supported chain and token**. The merchant is credited in their **local currency** (RWF, NGN, KES, GHS, USD) and the money lands as **USDC**, routed by **NEAR Intents**.

**Problem.** Small merchants in Africa get paid by people who hold money on different chains and in different tokens. Supporting each chain means a wallet, a bridge and a reconciliation process per chain.

**How NEAR is used.**
- **1Click API (NEAR Intents)** turns "customer holds token X on chain Y" into "merchant receives USDC", with one quote and one deposit address per invoice. (`src/services/nearIntents.ts`)
- The quote is `EXACT_OUTPUT`: the merchant receives exactly the invoice value, and the customer's input absorbs slippage.
- Settlement is by polling 1Click `/v0/status`; `SUCCESS` credits the merchant ledger, `REFUNDED` and `FAILED` are shown to the customer. (`src/services/cryptoInvoice.ts`)
- The treasury can be a **NEAR Intents account** (`NEAR_INTENTS_RECIPIENT=treasury.near`, `NEAR_INTENTS_RECIPIENT_TYPE=INTENTS`), which is cheaper than delivering to an EVM address.

## Try it (no WhatsApp, no API keys, no funds)

Requires Node 18+. Steps 1 to 5 only call the public 1Click API (quotes mint a deposit address; nothing moves until someone sends funds).

1. `npm install`
2. `cp .env.example .env` then set two values in `.env`:
   - `DATABASE_URL=file:./prisma/dev.db`
   - `NEAR_INTENTS_RECIPIENT=<an address you control>` (an `0x...` EVM address, or a NEAR account for an Intents treasury)
3. `npm run db:generate:sqlite && npm run db:push:sqlite`
4. `npm run demo:invoice` : prints an invoice reference and a **pay link**. See: `Pay link: http://localhost:3000/pay/3RIKE-...`
5. `npm run dev`, then open the pay link. Choose **USDC on arb** and press **Get payment details**. See: the exact amount to send, the network, the deposit address, a QR code, and a progress tracker waiting for payment.
6. *(Optional, real money, about $3.50)* Send exactly the amount shown, on the network shown, to the address. See: the tracker moves to "Payment received, converting" and then **Paid**; the merchant's ledger balance increases. Check with `npm run treasury:report`.

### Or with Docker (API + Redis + Postgres, one command)

1. `cp .env.example .env`, then set in `.env`:
   - `DATABASE_URL=postgresql://threerike:threerike@postgres:5432/threerike_pay`
   - `NEAR_INTENTS_RECIPIENT=<an address you control>`
   - `COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml` (publishes ports on your machine)
2. `docker compose --profile local-db up --build` (wait until `docker compose ps` shows the app as healthy)
3. `docker compose exec app node dist/cli/demoInvoice.js` : prints a **pay link**. Open it. See: the same pay page as above.
4. `docker compose logs app | grep -i queue` : See: `Durable crypto payment queue started`. Redis is wired in, so payment tracking runs on a BullMQ queue that survives restarts.

The app runs `prisma db push` on boot, so `DATABASE_URL` must point at a database you intend it to change.

**Deploying with Coolify.** `docker-compose.yml` is written for it: no fixed container names, no published ports, and none of your variables are set in the file. Use the "Docker Compose" build pack, set your variables in Coolify (see `.env.example`), give the `app` service your domain on port 3000, and use a Coolify or hosted Postgres through `DATABASE_URL` (do not enable the `local-db` profile). Redis persists to a volume and never evicts jobs, which the payment queue needs.

Other checks:
- `npm test` : unit tests (3 tests in `tests/webhooks.test.ts` fail on a clean checkout and are unrelated to this work).
- `npm run demo:probe` : prints the live token list and a live quote from the 1Click API, no server needed.
- Other currencies: `npm run demo:invoice -- NGN 20000`.
- There is **no testnet** for NEAR Intents, so step 6 uses mainnet with a small amount.

## What was built during the hackathon (and what was already here)

**Baseline (before the hackathon, commit `28cf5b5`, 16 Oct 2026):** a WhatsApp payment bot with Flutterwave mobile-money collections, AutoRamp bank transfers, a multi-currency ledger, merchant profiles, products and invoices.

**Built for the hackathon (NEAR work only):**
- `src/services/nearIntents.ts` : 1Click client (quotes, status, token list, fiat pricing, token resolution)
- `src/services/cryptoInvoice.ts` : create a crypto payment for an invoice, poll and settle it
- `src/api/pay.ts` + `public/pay.html` : the public customer pay page and its API
- `src/services/treasury.ts`, `src/services/withdrawal.ts` : treasury accounting and withdrawals (experimental; payouts need a signer and are **not** enabled)
- `scripts/demo-invoice.ts`, `scripts/probe-near-intents.js`, `scripts/treasury-report.ts`
- `tests/nearIntents.test.ts`, `tests/withdrawal.test.ts`
- Bot: invoice "Yes" now issues a crypto pay link when `PUBLIC_BASE_URL` is set; mobile money is switched off by default (`MOBILE_MONEY_ENABLED`).

**How a payment is detected.** NEAR Intents has no webhooks, so we poll its status endpoint. With `REDIS_URL` set, a BullMQ queue (`src/services/cryptoQueue.ts`) owns this: one self-rescheduling job per invoice, retries with back-off, a rate limiter, and a repeating sweep that re-adds any invoice that lost its job. Without Redis the same tracking runs in-process (`src/services/cryptoSweep.ts`), so no Redis is needed to try the project. Late payments on an already-expired invoice are still detected and settled.

**Known limits.** Prices use a static FX table (`NEAR_INTENTS_FX_RATES`); origin chains are EVM only (the refund address must be valid on the customer's chain); withdrawals are not production-ready.

---

# 3rike Pay

WhatsApp payment bot for sending money to Nigerian bank accounts. Built with Node.js, Express, Prisma, Redis, and the WhatsApp Cloud API. Integrated with AutoRamp for bank transfers and virtual account issuing.

## Features

- **WhatsApp chat bot** — users send, check balance, and verify identity from WhatsApp.
- **WhatsApp Flows** — KYC onboarding and transfer PIN authorization happen inside encrypted WhatsApp Forms.
- **Natural transfer** — users can type things like `send 5k to 1234567890 gtbank` or `transfer four thousand naira to 1234567890 access`.
- **AutoRamp integration** — name enquiry, sub-account creation, and transfers.
- **Redis sessions** — ephemeral user state with per-state TTL (KYC 30 min, transfer 10 min, default 24 h).
- **Dry-run mode** — test the full flow without real money or DB writes.
- **WhatsApp templates** — `transfer_complete`, `transfer_failed`, `onboarding_message`.

## Tech Stack

- Node.js + TypeScript
- Express
- Prisma ORM (SQLite/Postgres)
- Redis (sessions + pending transfer state)
- WhatsApp Cloud API
- AutoRamp API

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env vars
cp .env.example .env

# 3. Fill in .env
#   - DATABASE_URL
#   - WHATSAPP_* tokens
#   - AUTORAMP_API_KEY
#   - REDIS_URL (optional but recommended)
#   - DRY_RUN=true for testing

# 4. Push DB schema
npm run db:push:sqlite

# 5. Start dev server
npm run dev
```

## Environment Variables

Key env vars (see `.env.example` for full list):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | SQLite or Postgres connection string |
| `WHATSAPP_ACCESS_TOKEN` | Permanent token for WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp phone number ID |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WABA ID |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification token |
| `AUTORAMP_API_KEY` | AutoRamp API key |
| `REDIS_URL` | Redis connection (e.g. `redis://localhost:6379`) |
| `DRY_RUN` | `true` to skip real money/DB side effects |

## Webhook Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /webhook/whatsapp` | WhatsApp webhook verification |
| `POST /webhook/whatsapp` | Incoming WhatsApp messages/status |
| `POST /webhook/autoramp` | AutoRamp events |
| `POST /webhook/flow/kyc` | KYC WhatsApp Flow payload |
| `POST /webhook/flow/transfer` | Transfer PIN Flow payload |

## Dry-Run Commands

When `DRY_RUN=true`, these commands are active:

- `/dry kyc` — open KYC Flow
- `/dry send <natural transfer>` — test a transfer, e.g. `/dry send 5k to 1234567890 gtbank`
- `/dry airtime` — placeholder
- `/clear` — reset session

## Natural Transfer Examples

Users can type:

```text
send 5000 naira to 1234567890 gtbank
transfer 4k to 1234567890 opay
pay five thousand naira to 1234567890 access bank
```

The bot extracts amount, 10-digit account number, and bank name, does name enquiry, then sends a Yes/No confirmation.

## Project Structure

```
src/
  api/              # Express routes (webhooks, flows, notify)
  bot/              # Conversation state machine
  config/           # JSON configs: messages, flows, templates, customMessages
  services/         # WhatsApp, AutoRamp, database, Redis, sessions
  utils/            # helpers, flow crypto, pin hashing, message builder
flows/              # WhatsApp Flow JSON definitions
prisma/             # Prisma schema
```

## Scripts

```bash
npm run dev             # Start dev server
npm run typecheck       # TypeScript check
npm run build           # Build for production
npm run start           # Run production build
npm run db:push:sqlite  # Push Prisma schema to SQLite
```

## Important Notes

- WhatsApp Flow encryption keys can be set via `FLOW_PRIVATE_KEY`, `FLOW_PRIVATE_KEY_BASE64`, or `FLOW_PRIVATE_KEY_PATH`.
- Flow IDs and template names are configured in `src/config/flows.json` and `src/config/templates.json`.
- Templates must be approved in Meta Business Manager before use outside the 24h window.

## License

ISC
