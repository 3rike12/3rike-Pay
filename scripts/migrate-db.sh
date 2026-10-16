#!/usr/bin/env bash
# Migrate data from the current DATABASE_URL (source) to a fresh target DB.
# The target schema must already exist (e.g. via `npx prisma db push`).
#
# Usage:
#   ./scripts/migrate-db.sh <TARGET_DATABASE_URL>
#
# Example:
#   ./scripts/migrate-db.sh "postgresql://threerike:threreike@localhost:5432/threerike_pay"

set -euo pipefail

TARGET_URL="${1:-}"

if [ -z "$TARGET_URL" ]; then
  echo "Usage: $0 <TARGET_DATABASE_URL>"
  echo "Example: $0 postgresql://user:pass@host:5432/dbname"
  exit 1
fi

# Load DATABASE_URL from .env if it exists
if [ -f .env ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' .env | xargs -0 2>/dev/null || true)
fi

SOURCE_URL="${DATABASE_URL:-}"

if [ -z "$SOURCE_URL" ]; then
  echo "Error: DATABASE_URL is not set. Add it to .env or export it."
  exit 1
fi

echo "Source: $SOURCE_URL"
echo "Target: $TARGET_URL"
echo ""

# Check required tools
command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump not found. Install postgresql-client."; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql not found. Install postgresql-client."; exit 1; }

echo "Dumping data from source..."
pg_dump "$SOURCE_URL" \
  --data-only \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --inserts \
  > /tmp/3rike_pay_data_dump.sql

echo "Restoring data to target..."
psql "$TARGET_URL" < /tmp/3rike_pay_data_dump.sql

echo ""
echo "Migration complete."
