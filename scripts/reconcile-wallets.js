// Reconcile merchant/platform wallet balances against real Flutterwave settlement.
//
// Usage:
//   node scripts/reconcile-wallets.js                    # report only, no writes
//   node scripts/reconcile-wallets.js --apply            # write the corrections
//
// Options:
//   --sandbox=REF1,REF2   invoice refs whose credits are phantom test charges
//                         (default: the two known sandbox collections)
//   --fee=REF:AMOUNT      Flutterwave fee (incl. VAT) owed on an invoice
//   --yes                 skip the interactive confirm before --apply
//
// The script is idempotent: a correction already present in the ledger is
// reported as SKIP and never written twice. Corrections are booked as plain
// debit LedgerEntry rows so the audit trail stays intact.
//
// Env required: DATABASE_URL (see .env).

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Phantom collections credited to the merchant but never funded (test-mode
// charges). Reversed in full.
const DEFAULT_SANDBOX_REFS = [
  "3RIKE-20261001-WISYAR",
  "3RIKE-20261003-AC4B6I",
];

// Flutterwave fee owed per invoice. This is the *total* fee including VAT,
// i.e. amount - amount_settled, NOT Flutterwave's app_fee field: app_fee
// excludes the VAT line, so debiting it alone leaves the merchant short.
// (Proven on the RWF 3,000 charges: app_fee 147, amount_settled 2841.97,
// so the real fee is 158.03 = 147 app_fee + 11.03 VAT.)
const DEFAULT_FEES = {
  "3RIKE-20261005-4BU4OT": 5.92, // RWF 100 charge, settled 94.08
};

const round2 = (n) => Math.round(n * 100) / 100;

function parseArgs(argv) {
  const args = { apply: false, yes: false, sandboxRefs: null, fees: null };
  for (const raw of argv) {
    if (raw === "--apply") args.apply = true;
    else if (raw === "--yes") args.yes = true;
    else if (raw.startsWith("--sandbox=")) {
      args.sandboxRefs = raw.slice("--sandbox=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (raw.startsWith("--fee=")) {
      const [ref, amt] = raw.slice("--fee=".length).split(":");
      if (!ref || !amt) throw new Error(`Bad --fee "${raw}", expected REF:AMOUNT`);
      args.fees = args.fees || {};
      args.fees[ref.trim()] = Number(amt);
    } else {
      throw new Error(`Unknown argument "${raw}"`);
    }
  }
  return args;
}

async function load() {
  const wallets = await prisma.wallet.findMany({
    include: { user: { select: { phone: true, name: true } } },
  });
  const entries = await prisma.ledgerEntry.findMany({ orderBy: { createdAt: "asc" } });
  const platform = await prisma.user.findUnique({ where: { phone: "system:platform" } });
  return { wallets, entries, platform };
}

function ownerOf(wallets, walletId) {
  const w = wallets.find((x) => x.id === walletId);
  return w ? w.userId : null;
}

function alreadyBooked(entries, walletId, reference, reason) {
  return entries.some(
    (e) =>
      e.walletId === walletId &&
      e.direction === "debit" &&
      e.reference === reference &&
      e.metadata &&
      e.metadata.type === "reconciliation" &&
      e.metadata.reason === reason
  );
}

// Build the correction list from the ledger itself - nothing is hard-wired
// beyond which refs count as sandbox and what each Flutterwave fee was.
function buildCorrections({ wallets, entries }, sandboxRefs, feeMap) {
  const byRef = new Map();
  for (const e of entries) {
    if (!byRef.has(e.reference)) byRef.set(e.reference, []);
    byRef.get(e.reference).push(e);
  }

  const corrections = [];

  for (const [ref, rows] of byRef) {
    const credit = rows.find(
      (r) => r.direction === "credit" && r.metadata && r.metadata.type === "invoice"
    );
    if (!credit) continue;

    const userId = ownerOf(wallets, credit.walletId);
    const currency = credit.currency;
    const split = credit.metadata.split || null;
    const debits = rows.filter((r) => r.walletId === credit.walletId && r.direction === "debit");

    const push = (reason, amount, description) => {
      if (!(amount > 0)) return;
      corrections.push({
        ref,
        reason,
        userId,
        currency,
        amount: round2(amount),
        description,
        done: alreadyBooked(entries, credit.walletId, ref, reason),
        walletId: credit.walletId,
      });
    };

    if (sandboxRefs.includes(ref)) {
      // The whole collection is phantom - undo the merchant credit outright.
      push(
        "sandbox_charge",
        credit.amount,
        `Reconciliation: reverse test-mode charge for invoice ${ref}`
      );
      continue;
    }

    // How the merchant was credited. Old code credited merchantShare (net),
    // new code credits the gross amount and debits the platform fee.
    const creditedMode = !split
      ? "no-split"
      : credit.amount === split.gross
        ? "gross"
        : credit.amount === split.merchantShare
          ? "net"
          : "unknown";

    const hasFlutterwaveDebit = debits.some((d) =>
      (d.description || "").includes("Flutterwave fee")
    );
    const hasPlatformDebit = debits.some((d) => (d.description || "").includes("Platform fee"));
    const platformCredit = rows.find(
      (r) => r.direction === "credit" && r.metadata && r.metadata.type === "platform_fee"
    );

    const fee = feeMap[ref];

    if (fee !== undefined && !hasFlutterwaveDebit) {
      push(
        "flutterwave_fee",
        fee,
        `Flutterwave fee for invoice ${ref}`
      );
    } else if (fee === undefined) {
      corrections.push({
        ref,
        reason: "flutterwave_fee",
        userId,
        currency,
        amount: null,
        description: "Flutterwave fee for invoice " + ref,
        done: false,
        needsFee: true,
        walletId: credit.walletId,
      });
    }

    if (creditedMode === "gross") {
      const platformFee = split.platformFee || 0;
      if (platformFee > 0 && !hasPlatformDebit) {
        push("platform_fee", platformFee, `Platform fee for invoice ${ref}`);
      }
      if (platformFee > 0 && !platformCredit) {
        corrections.push({
          ref,
          reason: "platform_credit",
          userId: "system:platform",
          currency,
          amount: round2(platformFee),
          description: `Platform fee for invoice ${ref}`,
          done: false,
          isCredit: true,
          walletId: null,
        });
      }
    }
  }

  return corrections;
}

function printWallets(label, wallets) {
  console.log(`\n${label}`);
  for (const w of wallets) {
    const role = w.user && w.user.phone === "system:platform" ? "  <-- PLATFORM" : "";
    console.log(
      `  ${String(w.balance).padStart(10)} ${w.currency}  ${w.user ? w.user.phone : w.userId}  "${w.user ? w.user.name : ""}"${role}`
    );
  }
}

function printPlan(corrections) {
  const delta = {};
  console.log("\n=== CORRECTIONS ===");
  let any = false;
  for (const c of corrections) {
    if (c.needsFee) {
      any = true;
      console.log(
        `  ?? NEEDS FEE   ${c.ref}  Flutterwave fee unknown - pass --fee=${c.ref}:AMOUNT`
      );
      continue;
    }
    any = true;
    if (c.done) {
      console.log(`  SKIP           ${c.reason.padEnd(16)} ${c.ref}  ${c.amount} ${c.currency} (already booked)`);
      continue;
    }
    const sign = c.isCredit ? 1 : -1;
    delta[c.userId] = round2((delta[c.userId] || 0) + sign * c.amount);
    const verb = c.isCredit ? "CREDIT" : "DEBIT ";
    console.log(
      `  ${verb} ${c.reason.padEnd(16)} ${c.ref}  ${sign > 0 ? "+" : "-"}${c.amount} ${c.currency}`
    );
  }
  if (!any) console.log("  (none)");
  return delta;
}

function printProjection(wallets, delta, platform) {
  console.log("\n=== PROJECTED ===");
  for (const w of wallets) {
    const d = delta[w.userId] || 0;
    const after = round2(w.balance + d);
    const role = platform && w.userId === platform.id ? "  <-- PLATFORM" : "";
    const mark = d === 0 ? "" : `   ${d > 0 ? "+" : ""}${d}`;
    console.log(
      `  ${String(w.balance).padStart(10)}${mark.padStart(12)} -> ${String(after).padStart(10)} ${w.currency}  ${w.user ? w.user.phone : w.userId}${role}`
    );
  }
}

async function applyCorrections(corrections) {
  let written = 0;
  for (const c of corrections) {
    if (c.done || c.needsFee) continue;
    const sign = c.isCredit ? 1 : -1;

    await prisma.$transaction(async (tx) => {
      let wallet;
      if (c.isCredit && c.userId === "system:platform" && !c.walletId) {
        // The platform wallet may not exist yet on a fresh environment.
        const platform = await tx.user.findUnique({ where: { phone: "system:platform" } });
        if (!platform) throw new Error("system:platform user not found");
        wallet = await tx.wallet.findUnique({
          where: { userId_currency: { userId: platform.id, currency: c.currency } },
        });
        if (!wallet) {
          wallet = await tx.wallet.create({
            data: { userId: platform.id, currency: c.currency, balance: 0 },
          });
        }
      } else {
        wallet = await tx.wallet.findUnique({ where: { id: c.walletId } });
        if (!wallet) throw new Error(`wallet ${c.walletId} not found for ${c.ref}`);
      }

      const current = await tx.wallet.findUnique({ where: { id: wallet.id } });
      const next = round2(current.balance + sign * c.amount);

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: next },
      });

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          direction: sign > 0 ? "credit" : "debit",
          amount: c.amount,
          currency: c.currency,
          runningBalance: updated.balance,
          reference: c.ref,
          description: c.description,
          metadata: {
            type: "reconciliation",
            reason: c.reason,
            script: "scripts/reconcile-wallets.js",
            correctedAt: new Date().toISOString(),
          },
        },
      });
    });

    written += 1;
    console.log(
      `  wrote ${sign > 0 ? "CREDIT" : "DEBIT"} ${c.amount} ${c.currency} on ${c.ref}`
    );
  }
  return written;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sandboxRefs = args.sandboxRefs || DEFAULT_SANDBOX_REFS;
  const feeMap = { ...DEFAULT_FEES, ...(args.fees || {}) };

  const state = await load();
  const corrections = buildCorrections(state, sandboxRefs, feeMap);

  console.log("=== WALLET RECONCILIATION ===");
  console.log(`  mode: ${args.apply ? "APPLY" : "REPORT ONLY (no writes)"}`);
  console.log(`  sandbox refs: ${sandboxRefs.join(", ") || "(none)"}`);
  console.log(`  known fees: ${Object.entries(feeMap).map(([r, a]) => `${r}=${a}`).join(", ") || "(none)"}`);

  printWallets("=== BEFORE ===", state.wallets);
  const delta = printPlan(corrections);
  printProjection(state.wallets, delta, state.platform);

  const unresolved = corrections.filter((c) => c.needsFee);
  const pending = corrections.filter((c) => !c.done && !c.needsFee);

  if (unresolved.length) {
    console.log(
      `\n!! ${unresolved.length} correction(s) have no known Flutterwave fee. ` +
        `Pass --fee=REF:AMOUNT to include them.`
    );
  }

  if (!args.apply) {
    console.log(
      `\nReport only - ${pending.length} correction(s) pending. ` +
        `Re-run with --apply to write them.`
    );
    return;
  }

  if (pending.length === 0) {
    console.log("\nNothing to apply - ledger is already reconciled.");
    return;
  }

  if (!args.yes) {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) =>
      rl.question(`\nWrite ${pending.length} correction(s)? type "apply": `, res)
    );
    rl.close();
    if (answer.trim() !== "apply") {
      console.log("Aborted - no writes made.");
      process.exitCode = 1;
      return;
    }
  }

  const written = await applyCorrections(corrections);
  console.log(`\nWrote ${written} ledger entr${written === 1 ? "y" : "ies"}.`);

  const after = await load();
  printWallets("=== AFTER ===", after.wallets);
}

main()
  .catch((e) => {
    console.error("\nFAILED:", e.message || e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
