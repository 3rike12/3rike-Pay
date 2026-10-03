// Reproduce the v3 Rwanda mobile-money charge against the configured
// environment - read-only in the sense that it touches no app data, but it
// does create a sandbox/test charge with a fake number, so no handset is
// ever prompted.
//
// Usage: node scripts/probe-rwanda-charge.js
//
// Env required: FLUTTERWAVE_SECRET_KEY.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const V3_BASE = "https://api.flutterwave.com";

async function main() {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secretKey) {
    console.error("FLUTTERWAVE_SECRET_KEY is unset.");
    process.exit(1);
  }

  const txRef = `PROBE-${Date.now()}`;
  const payload = {
    tx_ref: txRef,
    order_id: txRef,
    amount: 10,
    currency: "RWF",
    email: "probe@example.com",
    phone_number: "+250780000000",
    fullname: "Probe Tester",
    redirect_url: "https://example.com/done",
  };

  console.log("POST /v3/charges?type=mobile_money_rwanda");
  console.log({ txRef, amount: payload.amount, phone: payload.phone_number });

  const response = await fetch(`${V3_BASE}/v3/charges?type=mobile_money_rwanda`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);

  console.log("\nResponse");
  console.log(`  http    ${response.status}`);
  console.log(`  status  ${body?.status ?? "(none)"}`);
  console.log(`  code    ${body?.code ?? "(none)"}`);
  console.log(`  message ${body?.message ?? "(none)"}`);
  if (body?.data) {
    console.log(`  data    ${JSON.stringify(body.data).slice(0, 400)}`);
  }
  if (body?.meta) {
    console.log(`  meta    ${JSON.stringify(body.meta).slice(0, 400)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
