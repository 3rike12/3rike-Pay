// Who holds what, what we owe, and whether the on-chain treasury covers it.
//   npx ts-node -r tsconfig-paths/register --transpile-only scripts/treasury-report.ts
import "dotenv/config";
import { holdingsByUser, liabilities, solvency } from "@/services/treasury";

(async () => {
  const holdings = await holdingsByUser();
  console.log("\nHOLDINGS (non-zero wallets)");
  for (const h of holdings) {
    console.log(`  ${(h.phone ?? h.userId).padEnd(18)} ${h.currency.padEnd(4)} ${h.balance.toFixed(2).padStart(14)}   ≈ $${h.usd.toFixed(2)}`);
  }

  const owed = await liabilities();
  console.log("\nLIABILITIES BY CURRENCY");
  for (const [cur, r] of Object.entries(owed.byCurrency)) {
    console.log(`  ${cur.padEnd(4)} ${r.balance.toFixed(2).padStart(14)}   ≈ $${r.usd.toFixed(2)}`);
  }
  console.log(`  TOTAL ≈ $${owed.totalUsd.toFixed(2)}`);

  try {
    const s = await solvency();
    console.log(`\nTREASURY on-chain: $${s.assetsUsd.toFixed(2)}   surplus: $${s.surplusUsd.toFixed(2)}   ${s.covered ? "COVERED" : "*** SHORTFALL ***"}`);
  } catch (e: any) {
    console.log(`\nTREASURY on-chain: unavailable (${e.message})`);
  }
  process.exit(0);
})();
