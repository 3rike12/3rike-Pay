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
