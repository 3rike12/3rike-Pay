// Cash-outs waiting for the treasury to send USDC (no signer is registered).
// For each one: send EXACTLY the USDC amount on Base to the deposit address,
// and AutoRamp pays the NGN to the merchant's bank.
//   npm run cashout:pending
import "dotenv/config";
import { prisma } from "@/db/prisma";
import { listStuckCashouts } from "@/services/cashout";

(async () => {
  const rows = await prisma.transaction.findMany({
    where: { type: "cashout", status: "awaiting_signature" },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) console.log("No cash-outs are waiting for funding.");
  for (const tx of rows) {
    const m: any = tx.metadata || {};
    console.log(
      `\n${tx.reference}  ${tx.createdAt.toISOString()}\n` +
        `  send   ${m.usdc} USDC (Base)\n  to     ${m.depositAddress}\n` +
        `  pays   NGN ${m.ngn} -> ${tx.bankName ?? tx.bankCode} ${tx.bankAccount} (${tx.accountName ?? "?"})`
    );
  }
  console.log(`\nAfter sending, AutoRamp's offramp.completed webhook closes the cash-out.`);

  // AutoRamp reports by webhook only. A missed one leaves the user debited and the payout open.
  const stuck = await listStuckCashouts();
  if (stuck.length) {
    console.log(`\nSent more than an hour ago and still not closed by AutoRamp (check each in AutoRamp's dashboard):`);
    for (const tx of stuck) {
      const m: any = tx.metadata || {};
      console.log(`  ${tx.reference}  ${tx.createdAt.toISOString()}  NGN ${m.ngn}  funded: ${m.fundingTx ?? "no tx recorded"}`);
    }
    console.log(`If AutoRamp shows it paid, resend its offramp.completed webhook; if it failed, offramp.failed credits the user back.`);
  }
  await prisma.$disconnect();
})();
