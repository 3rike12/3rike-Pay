// Screenshot a local HTML file with a GPU-backed Chromium.
//   node tools/shoot.mjs <file.html> <out.png> [width] [height]
import { chromium } from "/Users/admin/.pg/jumpa-web-app/node_modules/playwright/index.mjs";
const [file, out, w = "1920", h = "1080"] = process.argv.slice(2);
const b = await chromium.launch({ channel: "chrome", args: [
  "--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist",
  "--enable-gpu-rasterization", "--hide-scrollbars"] });
const pg = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
await pg.goto("file://" + file);
await pg.waitForTimeout(900);
console.log("title:", await pg.title());
await pg.screenshot({ path: out, fullPage: true });
await b.close();
