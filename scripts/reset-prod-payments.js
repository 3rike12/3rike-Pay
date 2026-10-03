// Report / back up / wipe the payment-side rows in the prod database.
//
// Usage:
//   node scripts/reset-prod-payments.js            # counts + JSON backup, no writes
//   node scripts/reset-prod-payments.js --wipe     # backup, then delete payment rows
//
// Wiped by --wipe: WebhookEvent, Invoice, Transaction, FlutterwaveSubaccount.
// Kept: User, UserProfile, BankAccount, UserCredential, UserSession, Wallet,
// LedgerEntry, Business, Product - so merchants stay registered and logged in.
//
// Env required: DATABASE_URL (see .env).

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const ALL_MODELS = [
  "user",
  "userProfile",
  "bankAccount",
  "userCredential",
  "userSession",
  "transaction",
  "wallet",
  "ledgerEntry",
  "business",
  "flutterwaveSubaccount",
  "product",
  "invoice",
  "webhookEvent",
];

// Payment-side rows only. Nothing references these, so no FK ordering rules.
const WIPE_MODELS = ["webhookEvent", "invoice", "transaction", "flutterwaveSubaccount"];

const BACKUP_DIR = path.resolve(__dirname, "..", "backups");

async function counts() {
  const out = {};
  for (const model of ALL_MODELS) {
    out[model] = await prisma[model].count();
  }
  return out;
}

function printCounts(label, c) {
  console.log(`\n${label}`);
  for (const model of ALL_MODELS) {
    console.log(`  ${model.padEnd(24)} ${c[model]}`);
  }
}

async function report() {
  const subs = await prisma.flutterwaveSubaccount.findMany({
    select: {
      id: true,
      userId: true,
      subaccountId: true,
      businessName: true,
      currency: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nFlutterwave subaccounts (${subs.length})`);
  for (const s of subs) {
    console.log(
      `  ${s.subaccountId}  ${s.currency}  ${s.businessName}  user=${s.userId}  created=${s.createdAt.toISOString()}`
    );
  }

  const invoiceRows = await prisma.invoice.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  console.log("\nInvoices by status");
  for (const row of invoiceRows) {
    console.log(`  ${String(row.status).padEnd(20)} ${row._count._all}`);
  }
}

async function backup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `prod-payments-${stamp}.json`);

  const payload = { generatedAt: new Date().toISOString(), tables: {} };
  for (const model of ALL_MODELS) {
    payload.tables[model] = await prisma[model].findMany();
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));

  const stat = fs.statSync(file);
  if (stat.size <= 2) throw new Error("Backup file is empty");
  const rows = Object.values(payload.tables).reduce((n, t) => n + t.length, 0);
  console.log(`\nBackup written: ${file} (${rows} rows, ${stat.size} bytes)`);
  return file;
}

async function wipe() {
  const before = await counts();
  printCounts("Counts before wipe", before);

  const file = await backup();
  if (!fs.existsSync(file)) throw new Error("Backup missing - aborting wipe");

  const results = await prisma.$transaction(
    WIPE_MODELS.map((model) => prisma[model].deleteMany())
  );
  console.log("\nDeleted");
  WIPE_MODELS.forEach((model, i) => {
    console.log(`  ${model.padEnd(24)} ${results[i].count}`);
  });

  const after = await counts();
  printCounts("Counts after wipe", after);

  const keptDrift = ALL_MODELS.filter(
    (m) => !WIPE_MODELS.includes(m) && before[m] !== after[m]
  );
  if (keptDrift.length) {
    console.error(`\nERROR: kept tables changed: ${keptDrift.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const leftover = WIPE_MODELS.filter((m) => after[m] !== 0);
  if (leftover.length) {
    console.error(`\nERROR: wipe tables not empty: ${leftover.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nWipe complete - kept tables untouched.");
}

async function main() {
  const wipeRequested = process.argv.includes("--wipe");

  console.log(`Database: ${String(process.env.DATABASE_URL || "").split("@")[1] || "(unset)"}`);
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set - refusing to run.");
    process.exit(1);
  }

  if (wipeRequested) {
    await wipe();
    return;
  }

  const before = await counts();
  printCounts("Current counts", before);
  await report();
  await backup();
  console.log("\nRead-only pass complete. Re-run with --wipe to delete payment rows.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
