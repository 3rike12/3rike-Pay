#!/usr/bin/env node
// Live smoke test for NEAR Intents 1Click. Needs no API key for the token
// list or a DRY quote (dry quotes create no deposit address and move no money).
//
//   node scripts/probe-near-intents.js                 # tokens + dry quote for 2 USDC
//   NEAR_INTENTS_API_KEY=... NEAR_INTENTS_RECIPIENT=0x... node scripts/probe-near-intents.js --wet
//   (--wet mints a REAL deposit address; sending funds to it is a real swap.)
const base = process.env.NEAR_INTENTS_BASE_URL || "https://1click.chaindefuser.com";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const wet = process.argv.includes("--wet");
const recipient = process.env.NEAR_INTENTS_RECIPIENT || "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";

(async () => {
  const tokens = await (await fetch(`${base}/v0/tokens`)).json();
  console.log(`tokens: ${tokens.length}`);

  const headers = { "Content-Type": "application/json" };
  if (process.env.NEAR_INTENTS_API_KEY) headers.Authorization = `Bearer ${process.env.NEAR_INTENTS_API_KEY}`;
  const res = await fetch(`${base}/v0/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dry: !wet,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: USDC_ARB,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_BASE,
      amount: "2000000",
      refundTo: recipient,
      refundType: "ORIGIN_CHAIN",
      recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  });
  const body = await res.json();
  console.log(`quote (${wet ? "WET" : "dry"}) http ${res.status}`);
  console.log(JSON.stringify(body.quote ?? body, null, 2));

  const addr = body.quote?.depositAddress;
  if (addr) {
    const st = await fetch(`${base}/v0/status?depositAddress=${addr}`, { headers });
    console.log(`status http ${st.status}`, await st.json());
  }
})().catch((e) => { console.error(e); process.exit(1); });
