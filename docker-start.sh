#!/bin/sh
# Start the app. First bring the database schema up to date, but never let that stop the app from starting.
#
# `prisma db push` hangs on a pooled connection (Neon's "-pooler" host, PgBouncer): it needs a session-level lock the pooler
# cannot give, so a deploy would sit here forever. So the push uses the direct host (the same URL without "-pooler"), and
# is cut off after 60 seconds. If it fails or times out the app still starts on the schema already in the database
# (existing databases were migrated with prisma/migration-stocks-and-ledger.sql), and the reason is in the log.
set -u
PUSH_URL="${DIRECT_DATABASE_URL:-$(printf '%s' "${DATABASE_URL:-}" | sed 's/-pooler\././')}"
echo "[start] Updating the database schema (60s limit)"
if DATABASE_URL="$PUSH_URL" timeout 60 npx prisma db push --skip-generate; then
  echo "[start] Database schema is up to date"
else
  echo "[start] WARNING: the schema update failed or timed out (exit $?). Starting the app on the schema already in the database."
fi
exec node dist/index.js
