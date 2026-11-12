// Create a demo merchant + invoice without WhatsApp, and print the buyer pay link.
//   npm run demo:invoice            # default: 3 x batteries @ RWF 1,000
//   npm run demo:invoice -- NGN 20000
// In Docker (compiled with the app):
//   docker compose exec app node dist/cli/demoInvoice.js [CURRENCY] [UNIT_PRICE]
import "dotenv/config";
import { prisma } from "@/db/prisma";
import { config } from "@/config";
import { createDraftInvoice, issueInvoice } from "@/services/invoice";
import { createDefaultCryptoPayment } from "@/services/cryptoInvoice";
import { nearIntents } from "@/services/nearIntents";

(async () => {
  const currency = (process.argv[2] || "RWF").toUpperCase();
  const unitPrice = Number(process.argv[3] || 1000);

  const merchant = await prisma.user.upsert({
    where: { phone: "demo:merchant" },
    update: {},
    create: { phone: "demo:merchant", name: "Demo Merchant" },
  });
  // Fictional demo data. A real merchant's page shows what THEY saved in the
  // bot's business-profile setup.
  const profile = {
    name: "Kigali Corner Shop",
    country: "RW",
    phone: "+250 788 123 456",
    email: "hello@kigalicorner.example",
    registrationNumber: "RDB-2026-04417",
  };
  await prisma.business.upsert({
    where: { userId: merchant.id },
    update: profile,
    create: { userId: merchant.id, ...profile },
  });

  const invoice = await createDraftInvoice({
    merchantId: merchant.id,
    buyerPhone: "0781234567",
    currency,
    items: [
      { name: "Batteries", qty: 3, unitPrice },
      { name: "Phone charger", qty: 1, unitPrice: unitPrice * 2 },
    ],
  });
  await issueInvoice(invoice.id, merchant.id);

  // Same as the bot: initiate the default payment so the link opens ready.
  if (nearIntents.isNearIntentsEnabled()) {
    await createDefaultCryptoPayment(merchant.id, invoice.id).catch((e) =>
      console.warn("Could not pre-create the payment (the page will request one):", e.message)
    );
  }

  const base = config.app.baseUrl || `http://localhost:${config.port}`;
  console.log(`\nInvoice ${invoice.reference}: ${invoice.amount} ${invoice.currency}`);
  console.log(`Pay link: ${base}/pay/${invoice.reference}\n`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
