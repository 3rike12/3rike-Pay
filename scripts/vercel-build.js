#!/usr/bin/env node
// Vercel build step for the separately hosted pay page.
//
// The React payment page calls the backend for invoice and merchant details.
// The backend address is set in Vercel as PAY_API_URL; emit it after the Vite build.
// from it at build time.
//
//   PAY_API_URL=https://api.example.com node scripts/vercel-build.js
const fs = require("fs");
const path = require("path");

/** Validate the URL and return the config.js source. Throws with a clear message. */
function buildConfig(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("PAY_API_URL is not set. Set it to your backend's public URL, e.g. https://api.example.com");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PAY_API_URL is not a valid URL: ${value}`);
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("PAY_API_URL must start with https:// (http:// is only allowed for localhost).");
  }
  const apiBase = url.origin; // origin only: no path, no trailing slash
  return `window.PAY_CONFIG = ${JSON.stringify({ apiBase })};\n`;
}

module.exports = { buildConfig };

if (require.main === module) {
  try {
    const out = path.join(__dirname, "..", "web", "dist", "config.js");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buildConfig(process.env.PAY_API_URL));
    // This Vercel project serves only the payment flow; the marketing site is
    // hosted separately, so keep the root path as a 404 as before.
    fs.rmSync(path.join(path.dirname(out), "index.html"), { force: true });
    console.log(`Wrote ${path.relative(process.cwd(), out)} for ${new URL(process.env.PAY_API_URL).origin}`);
  } catch (error) {
    console.error(`vercel-build: ${error.message}`);
    process.exit(1);
  }
}
