// Load the UDR pricing page, wait for content to render, and dump
// rendered HTML + visible text + a screenshot so we can figure out
// the right selectors for the production scraper.
//
// Usage: node scraper/discover_dom.js
// Outputs (gitignored): scraper/dom_dump_<timestamp>.{html,txt,png}

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;
const URL =
  "https://www.udr.com/los-angeles-apartments/marina-del-rey/the-westerly-on-lincoln/apartments-pricing/";

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });
  const page = await ctx.newPage();

  // Capture XHR/fetch URLs in case there's a JSON API we can hit directly.
  const apiCalls = [];
  page.on("response", (res) => {
    const url = res.url();
    const ct = res.headers()["content-type"] || "";
    if (ct.includes("json") || /\/(api|service|floorplan|pricing|units?|availability)/i.test(url)) {
      apiCalls.push({ status: res.status(), url, contentType: ct });
    }
  });

  console.log(`→ ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });

  // The SPA loads pricing async. Wait for a $ sign to show up in the body
  // (good enough heuristic for "pricing data has rendered").
  try {
    await page.waitForFunction(
      () => /\$\s?\d/.test(document.body?.innerText || ""),
      { timeout: 30000 },
    );
    console.log("✓ price text detected");
  } catch {
    console.warn("⚠ no $ price text found within 30s — dumping anyway");
  }

  // Let any trailing requests settle.
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const stamp = ts();
  const html = await page.content();
  const text = await page.evaluate(() => document.body.innerText);

  writeFileSync(resolve(OUT_DIR, `dom_dump_${stamp}.html`), html, "utf8");
  writeFileSync(resolve(OUT_DIR, `dom_dump_${stamp}.txt`), text, "utf8");
  await page.screenshot({
    path: resolve(OUT_DIR, `dom_dump_${stamp}.png`),
    fullPage: true,
  });

  // Also dump any API calls we noticed — these are the gold if they're JSON.
  writeFileSync(
    resolve(OUT_DIR, `dom_dump_${stamp}.api.json`),
    JSON.stringify(apiCalls, null, 2),
    "utf8",
  );

  console.log(`\nDumped (timestamp ${stamp}):`);
  console.log(`  HTML:  scraper/dom_dump_${stamp}.html`);
  console.log(`  TEXT:  scraper/dom_dump_${stamp}.txt`);
  console.log(`  PNG:   scraper/dom_dump_${stamp}.png`);
  console.log(`  APIs:  scraper/dom_dump_${stamp}.api.json  (${apiCalls.length} candidate calls)`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
