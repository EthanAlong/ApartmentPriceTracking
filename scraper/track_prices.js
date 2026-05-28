// Scrape every available unit at The Westerly on Lincoln and append one CSV
// row per unit to data/prices.csv.
//
// UDR's page ships every available unit's full data in the DOM at page load
// as data-* attributes on <li class="apartment"> elements inside
// #unitListingContainer. We read those attributes directly — no innerText
// parsing, no clicking LOAD MORE (LOAD MORE only toggles a CSS `show` class
// for already-rendered items).
//
// Usage: node scraper/track_prices.js
// Env:   DEBUG_DUMP=1   write a timestamped .json dump of the raw extracted
//                       attributes next to data/prices.csv (for post-mortems)

import { chromium } from "playwright";
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(REPO_ROOT, "data");
const CSV_PATH = resolve(DATA_DIR, "prices.csv");

const URL =
  "https://www.udr.com/los-angeles-apartments/marina-del-rey/the-westerly-on-lincoln/apartments-pricing/";

const CSV_COLUMNS = [
  "timestamp",
  "unit",
  "floorplan_name",
  "floorplan_code",
  "floorplan_id",
  "beds",
  "baths",
  "sqft",
  "rent",
  "base_rent",
  "floor",
  "available_date",
  "is_featured",
  "unit_id",
];
const CSV_HEADER = CSV_COLUMNS.join(",") + "\n";

function csvEscape(v) {
  if (v == null || v === "") return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseFloorplan(raw) {
  // "Voyager (A1F-R)" → { name: "Voyager", code: "A1F-R" }
  // "A1G"            → { name: "",         code: "A1G"   }
  if (!raw) return { name: "", code: "" };
  const m = /^\s*(.+?)\s*\(([^)]+)\)\s*$/.exec(raw);
  if (m) return { name: m[1].trim(), code: m[2].trim() };
  return { name: "", code: raw.trim() };
}

function toInt(s) {
  if (s == null || s === "") return null;
  const n = parseInt(String(s).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

async function extractUnits(page) {
  // Pull every data-* attribute we care about from the listing <li>s.
  return page.evaluate(() => {
    const lis = document.querySelectorAll(
      '#unitListingContainer li.apartment[data-rent]',
    );
    return Array.from(lis).map((li) => ({
      unit: li.dataset.number || li.dataset.title || "",
      floorplanRaw: li.dataset.floorPlanName || "",
      floorplanId: li.dataset.floorplanId || li.dataset.fid || "",
      beds: li.dataset.beds || "",
      baths: li.dataset.baths || "",
      sqft: li.dataset.sqft || "",
      rent: li.dataset.rent || "",
      baseRent: li.dataset.baseRent || "",
      floor: li.dataset.floorNumber || "",
      movedate: li.dataset.movedate || "",
      isFeatured: li.dataset.featuredApartment === "true",
      unitId: li.dataset.unitid || li.dataset.unitId || "",
    }));
  });
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });
  const page = await ctx.newPage();

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Listings render after a JS init; wait for at least one <li> with a rent.
  await page.waitForSelector(
    "#unitListingContainer li.apartment[data-rent]",
    { timeout: 30000 },
  );
  // Belt-and-suspenders: let any trailing hydration finish.
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  const raw = await extractUnits(page);
  await browser.close();
  return raw;
}

async function main() {
  const raw = await scrape();

  if (raw.length === 0) {
    console.error("ERROR: 0 units extracted. Page structure may have changed.");
    process.exit(2);
  }

  const ts = new Date().toISOString();
  const rows = raw.map((u) => {
    const fp = parseFloorplan(u.floorplanRaw);
    return {
      timestamp: ts,
      unit: u.unit,
      floorplan_name: fp.name,
      floorplan_code: fp.code,
      floorplan_id: u.floorplanId,
      beds: toInt(u.beds),
      baths: toInt(u.baths),
      sqft: toInt(u.sqft),
      rent: toInt(u.rent),
      base_rent: toInt(u.baseRent),
      floor: u.floor,
      available_date: u.movedate,
      is_featured: u.isFeatured,
      unit_id: u.unitId,
    };
  });

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CSV_PATH)) writeFileSync(CSV_PATH, CSV_HEADER, "utf8");

  const lines = rows.map((r) =>
    CSV_COLUMNS.map((c) => csvEscape(r[c])).join(","),
  );
  appendFileSync(CSV_PATH, lines.join("\n") + "\n", "utf8");

  console.log(`✓ ${rows.length} units written to data/prices.csv at ${ts}`);

  // Summary by bedrooms
  const byBeds = rows.reduce((acc, r) => {
    acc[r.beds] = (acc[r.beds] || 0) + 1;
    return acc;
  }, {});
  console.log("  By bedrooms:", byBeds);

  // The friend's target: 1B1B, 700-900 sqft
  const target = rows.filter(
    (r) => r.beds === 1 && r.baths === 1 && r.sqft >= 700 && r.sqft <= 900,
  );
  if (target.length) {
    console.log(`\nTarget (1B1B, 700-900 sqft): ${target.length} units`);
    for (const r of target.sort((a, b) => a.rent - b.rent)) {
      console.log(
        `  ${r.unit.padEnd(6)} $${r.rent.toLocaleString().padStart(6)}  ${String(r.sqft).padStart(3)} sqft  ${(r.floorplan_name || r.floorplan_code).padEnd(12)} floor ${r.floor}  avail ${r.available_date}`,
      );
    }
  }

  if (process.env.DEBUG_DUMP) {
    writeFileSync(
      resolve(__dirname, `dom_dump_${ts.replace(/[:.]/g, "-")}.json`),
      JSON.stringify(raw, null, 2),
      "utf8",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
