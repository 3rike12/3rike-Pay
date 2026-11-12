// Create a demo merchant + invoice without WhatsApp, and print the buyer pay link.
//   npm run demo:invoice            # default: 3 x batteries @ RWF 1,000
//   npm run demo:invoice -- NGN 20000
import "dotenv/config";
import { prisma } from "@/db/prisma";
import { config } from "@/config";
import { createDraftInvoice, issueInvoice } from "@/services/invoice";

(async () => {
  const currency = (process.argv[2] || "RWF").toUpperCase();
  const unitPrice = Number(process.argv[3] || 1000);

  const merchant = await prisma.user.upsert({
    where: { phone: "demo:merchant" },
    update: {},
    create: { phone: "demo:merchant", name: "Demo Merchant" },
  });
  await prisma.business.upsert({
    where: { userId: merchant.id },
    update: {},
    create: { userId: merchant.id, name: "Kigali Corner Shop", country: "RW" },
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

  const base = config.app.baseUrl || `http://localhost:${config.port}`;
  console.log(`\nInvoice ${invoice.reference}: ${invoice.amount} ${invoice.currency}`);
  console.log(`Pay link: ${base}/pay/${invoice.reference}\n`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
