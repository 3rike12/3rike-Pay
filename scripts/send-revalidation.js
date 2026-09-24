// Send the account revalidation flow message to one or more users.
//
// Sends a custom (non-template) interactive flow message: the body text plus
// a "Continue" button that opens the revalidation Flow. flow_token is set to
// the user's id so the flow endpoint can correlate the session, and the first
// screen is set to IDENTITY.
//
// Usage:
//   node scripts/send-revalidation.js <phone> [phone ...]
//
// Env required: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, DATABASE_URL.
// Optional: WHATSAPP_FLOW_REVALIDATION_ID (default 1034360419652896).

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { PrismaClient } = require("@prisma/client");
const axios = require("axios");

const prisma = new PrismaClient();

function cleanPhone(input) {
  let c = String(input).replace(/[^0-9+]/g, "");
  if (c.startsWith("+234")) c = "0" + c.slice(4);
  else if (c.startsWith("234")) c = "0" + c.slice(3);
  return c;
}

function toWhatsAppPhone(input) {
  let c = String(input).replace(/[^0-9+]/g, "").replace(/^\+/, "");
  if (c.startsWith("0")) c = "234" + c.slice(1);
  return c;
}

async function main() {
  const phones = process.argv.slice(2);
  if (!phones.length) {
    console.error("Usage: node scripts/send-revalidation.js <phone> [phone ...]");
    process.exit(1);
  }

  const apiVersion = process.env.WHATSAPP_API_VERSION || "v21.0";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !token) {
    console.error("Missing WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN");
    process.exit(1);
  }

  const flowId = process.env.WHATSAPP_FLOW_REVALIDATION_ID || "1034360419652896";
  const base = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`;

  for (const raw of phones) {
    const phoneLocal = cleanPhone(raw);
    const user = await prisma.user.findUnique({ where: { phone: phoneLocal } });
    if (!user) {
      console.error(`✗ ${phoneLocal}: no user found in DB`);
      continue;
    }

    const name = (user.name || "there").trim() || "there";
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toWhatsAppPhone(phoneLocal),
      type: "interactive",
      interactive: {
        type: "flow",
        body: {
          text: `Hi ${name}, your 3rike Pay account needs revalidation. Tap *Continue* to complete it.`,
        },
        action: {
          name: "flow",
          parameters: {
            flow_id: flowId,
            flow_cta: "Continue",
            flow_message_version: "3",
            flow_action: "navigate",
            flow_token: user.id,
            flow_action_payload: { screen: "IDENTITY" },
          },
        },
      },
    };

    try {
      const res = await axios.post(`${base}/messages`, payload, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      console.log(`✓ ${phoneLocal} (${name}): message ${res.data?.messages?.[0]?.id}`);
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.response?.data || error.message;
      console.error(`✗ ${phoneLocal}: ${JSON.stringify(detail)}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());