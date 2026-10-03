// Read-only Flutterwave probe - no charges, no writes.
//
// Usage: node scripts/probe-flutterwave.js
//
// Shows which environment the configured keys resolve to, then hits one
// harmless endpoint on each API:
//   v3  GET /v3/balances        (key + environment sanity check)
//   v4  GET /mobile-networks    (is Rwanda mobile money visible to the account?)
//
// Env required: FLUTTERWAVE_SECRET_KEY; optional v4 pair
// (FLUTTERWAVE_CLIENT_ID / FLUTTERWAVE_CLIENT_SECRET / FLUTTERWAVE_API_BASE).

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const V3_BASE = "https://api.flutterwave.com";
const TOKEN_URL =
  "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";

function mask(key) {
  if (!key) return "(unset)";
  if (key.length <= 12) return "(set, too short to mask)";
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

async function probeV3(secretKey) {
  const response = await fetch(`${V3_BASE}/v3/balances`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const body = await response.json().catch(() => null);
  return {
    status: response.status,
    ok: response.ok,
    message: body?.message ?? null,
    balances: Array.isArray(body?.data) ? body.data.length : null,
  };
}

async function probeV4() {
  const clientId = process.env.FLUTTERWAVE_CLIENT_ID;
  const clientSecret = process.env.FLUTTERWAVE_CLIENT_SECRET;
  const apiBase =
    process.env.FLUTTERWAVE_API_BASE ||
    (process.env.FLUTTERWAVE_PRODUCTION === "true"
      ? "https://f4bexperience.flutterwave.com"
      : "https://developersandbox-api.flutterwave.com");

  if (!clientId || !clientSecret) {
    return { skipped: "v4 credentials not set" };
  }

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  const tokenBody = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !tokenBody?.access_token) {
    return {
      apiBase,
      tokenStatus: tokenResponse.status,
      tokenError: tokenBody?.error_description || tokenBody?.error || null,
    };
  }

  const networksResponse = await fetch(
    `${apiBase}/mobile-networks?country=RW`,
    { headers: { Authorization: `Bearer ${tokenBody.access_token}` } }
  );
  const networksBody = await networksResponse.json().catch(() => null);
  const networks = Array.isArray(networksBody?.data)
    ? networksBody.data.map((n) => `${n.id ?? "?"}:${n.network ?? n.name ?? "?"}`)
    : null;

  return {
    apiBase,
    tokenStatus: tokenResponse.status,
    networksStatus: networksResponse.status,
    networksOk: networksResponse.ok,
    networksMessage: networksBody?.error?.message || networksBody?.message || null,
    networks,
  };
}

async function main() {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const publicKey = process.env.FLUTTERWAVE_PUBLIC_KEY;

  console.log("Environment");
  console.log(`  FLUTTERWAVE_PRODUCTION   ${process.env.FLUTTERWAVE_PRODUCTION || "(unset)"}`);
  console.log(`  public key               ${mask(publicKey)}`);
  console.log(`  secret key               ${mask(secretKey)}`);
  console.log(
    `  key environment          ${
      String(publicKey || "").startsWith("FLWPUBK_TEST-") ? "sandbox (TEST key)" : "live"
    }`
  );
  console.log(`  FLUTTERWAVE_API_BASE     ${process.env.FLUTTERWAVE_API_BASE || "(default)"}`);
  console.log(`  FLUTTERWAVE_SCENARIO_KEY ${process.env.FLUTTERWAVE_SCENARIO_KEY || "(unset)"}`);

  if (!secretKey) {
    console.error("\nFLUTTERWAVE_SECRET_KEY is unset - cannot probe v3.");
    process.exitCode = 1;
    return;
  }

  console.log("\nv3  GET /v3/balances");
  try {
    console.log(await probeV3(secretKey));
  } catch (error) {
    console.log({ error: error.message });
  }

  console.log("\nv4  token + GET /mobile-networks?country=RW");
  try {
    console.log(await probeV4());
  } catch (error) {
    console.log({ error: error.message });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
