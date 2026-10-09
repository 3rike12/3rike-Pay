/**
 * Capture the real product for the film.
 *
 * Everything the film shows of the app is taken from the live site, so this is
 * the only place screenshots come from. Two kinds of shot:
 *
 *  - full frames of a page, at DPR 2;
 *  - element shots of the chat transcripts and the fee ledger that the docs
 *    render from the bot's real message templates, at DPR 3 so a push-in still
 *    resolves on a 1920 frame.
 *
 * The site's header is fixed, so it lands on top of anything scrolled under it.
 * It is removed before every element shot.
 *
 *   node tools/capture.mjs <demo-dir> [site-url]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const DEMO = process.argv[2];
const SITE = process.argv[3] || "https://3rike-pay.vercel.app";
if (!DEMO) { console.error("usage: node tools/capture.mjs <demo-dir> [site-url]"); process.exit(1); }
const OUT = path.join(DEMO, "assets/shots");
fs.mkdirSync(OUT, { recursive: true });

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  args: ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist",
         "--enable-gpu-rasterization", "--hide-scrollbars"],
});

const PAGES = [
  { id: "home-hero", url: "/" },
  { id: "home-how",  url: "/", anchor: "#how" },
  { id: "home-feat", url: "/", anchor: "#features" },
  { id: "biz-hero",  url: "/business" },
  { id: "biz-fees",  url: "/business", anchor: "#fees" },
  { id: "doc-index", url: "/doc" },
];
const ELEMENTS = [
  { id: "wa-setup",     url: "/doc/setup",     sel: ".wa-paper" },
  { id: "wa-send",      url: "/doc/send",      sel: ".wa-paper" },
  { id: "wa-catalogue", url: "/doc/catalogue", sel: ".wa-paper" },
  { id: "wa-invoice",   url: "/doc/invoice",   sel: ".wa-paper", tallest: true },
  { id: "wa-paid",      url: "/doc/paid",      sel: ".wa-paper" },
  { id: "wa-balance",   url: "/doc/balance",   sel: ".wa-paper" },
  { id: "ledger",       url: "/doc/paid",      sel: "dl" },
  // The hero's chat panel plays its own scripted conversation; wait it out and
  // shoot the settled state.
  { id: "phone-hero",   url: "/",              sel: ".bg-wa-bg", settle: 6000 },
];

const man = {};
for (const j of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(SITE + j.url, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  if (j.anchor) await p.evaluate(a => document.querySelector(a)?.scrollIntoView({ behavior: "instant", block: "start" }), j.anchor);
  await p.waitForTimeout(1600);
  await p.screenshot({ path: path.join(OUT, `${j.id}.png`) });
  man[j.id] = { file: `assets/shots/${j.id}.png`, url: j.url, dpr: 2, w: 1600, h: 900, errors: errs };
  console.log(`${j.id.padEnd(13)} 1600x900${errs.length ? "  ERR " + errs[0].slice(0, 50) : ""}`);
  await ctx.close();
}

for (const j of ELEMENTS) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1500 }, deviceScaleFactor: 3 });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(SITE + j.url, { waitUntil: "networkidle" });
  if (!j.settle) await p.addStyleTag({ content: "header{display:none !important}" });
  await p.evaluate(() => document.fonts.ready);
  const all = await p.$$(j.sel);
  let el = all[0];
  if (j.tallest) {
    let best = -1;
    for (const c of all) { const bb = await c.boundingBox(); if (bb && bb.height > best) { best = bb.height; el = c; } }
  }
  if (!el) { console.log(`${j.id.padEnd(13)} MISSING ${j.sel}`); await ctx.close(); continue; }
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(j.settle || 1200);
  await el.screenshot({ path: path.join(OUT, `${j.id}.png`) });
  const box = await el.boundingBox();
  // Per-bubble geometry, so the composition can crop and reveal on real
  // message boundaries instead of guessed pixel offsets.
  const bubbles = await el.evaluate(root => {
    const rb = root.getBoundingClientRect();
    return [...root.children].map(c => {
      const r = c.getBoundingClientRect();
      const inner = c.querySelector("[class*=bubble-]") || c;
      return { y: +(r.top - rb.top).toFixed(1), h: +r.height.toFixed(1),
               side: /bubble-out|wa-out/.test((inner.className || "").toString()) ? "you" : "bot",
               text: (c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) };
    }).filter(x => x.h > 8);
  });
  man[j.id] = { file: `assets/shots/${j.id}.png`, url: j.url, dpr: 3,
                w: +box.width.toFixed(1), h: +box.height.toFixed(1), bubbles, errors: errs };
  console.log(`${j.id.padEnd(13)} ${Math.round(box.width)}x${Math.round(box.height)}  ${bubbles.length} bubbles`);
  await ctx.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, "shots.json"), JSON.stringify(man, null, 2));
console.log(`\nwrote ${Object.keys(man).length} shots + shots.json`);
