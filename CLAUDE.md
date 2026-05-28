# ApartmentPriceTracking

Tracks pricing on **The Westerly on Lincoln** (UDR, Marina del Rey) so a friend
can watch a specific 1B1B 820sqft Voyager-floorplan unit over time without
having to open the website manually. Built in a single session — see "Origin
story" below if you want the full backstory.

**Dashboard**: https://ethanalong.github.io/ApartmentPriceTracking/
**Source page**: https://www.udr.com/los-angeles-apartments/marina-del-rey/the-westerly-on-lincoln/apartments-pricing/

## Architecture

```
GitHub Actions cron (5x/day, PT aligned)
        │
        ▼
Playwright (headless Chromium)
        │  scraper/track_prices.js
        ▼
data/prices.csv  ← append one row per available unit, per scrape
        │  bot commits with [skip ci]
        ▼
GitHub Pages (docs/index.html)
        │  fetch CSV from raw.githubusercontent.com (with cache-bust)
        ▼
Chart.js dashboard — friend opens link, sees price history
```

## File layout

| Path | Purpose |
|---|---|
| `scraper/track_prices.js` | Production scraper. Reads `data-*` attrs off `<li class="apartment">` inside `#unitListingContainer` — no text parsing, no LOAD MORE clicking. |
| `scraper/discover_dom.js` | Dev helper. Dumps rendered HTML / innerText / screenshot / observed API calls to `scraper/dom_dump_*.{html,txt,png,api.json}` (all gitignored). Run if the scraper breaks and you need to figure out what changed in UDR's DOM. |
| `data/prices.csv` | Append-only history. Columns: `timestamp,unit,floorplan_name,floorplan_code,floorplan_id,beds,baths,sqft,rent,base_rent,floor,available_date,is_featured,unit_id`. |
| `docs/index.html` | Single-file dashboard. Chart.js from CDN, fetches CSV from raw URL with per-minute cache-bust. Default filters: beds=1, sqft 700-900. |
| `.github/workflows/track.yml` | Cron 5x/day. Caches Playwright browsers. Commits CSV back via `github-actions[bot]`. Has retry-with-rebase on push to handle race between overlapping runs (concurrency group also guards against this). |
| `package.json` | `npm run track` → scrape · `npm run discover` → dump DOM for inspection. |

## Key design decisions — don't undo by accident

- **Use DOM `data-*` attrs, NOT innerText parsing.** UDR ships every available
  unit's full data (rent, sqft, beds, floorplan, move-in date, etc.) as
  `data-*` attributes on `<li class="apartment">` elements inside
  `#unitListingContainer`. Reading attributes is robust to UI tweaks; parsing
  innerText was tried first and broke because the page has unrelated
  "Apartment X" text in "Recently Viewed" / filter labels that polluted counts.
- **Don't click LOAD MORE.** All units are already in the DOM at page load.
  LOAD MORE only adds a CSS `show` class to items that are already rendered.
  The scraper queries `li.apartment[data-rent]` — gets all of them regardless
  of `show`/`active` classes — so studios, 1B, 2B all come through (currently
  41 total). The dashboard does the filtering.
- **Scrape everything, filter in the dashboard.** Don't filter to 1B1B in the
  scraper. Storing all bed counts means we can serve more queries (e.g., if
  the friend later wants 2B comparisons) with zero re-scraping.
- **Cron times are UTC aligned to PDT** (`13:34 / 16:38 / 19:41 / 22:36 / 04:11
  UTC` = `06:34 / 09:38 / 12:41 / 15:36 / 21:11 PT` during PDT). UDR refreshes
  pricing at 6/9/12/15 PT; each cron fires ~30 min after a refresh, plus an
  evening fallback. During PST (Nov-Mar) runs shift 1h later in PT but still
  safely land after each refresh — accepted as cheaper than DST-aware logic.
- **CSV is append-only with full snapshot every run.** Every scrape writes
  ~41 rows (one per available unit). At ~5 scrapes/day this is ~200 rows/day,
  ~75k rows/year. Still trivially loadable in the browser. If it ever bloats,
  prune by dropping rows older than N months.
- **Dashboard fetches from `raw.githubusercontent.com`, not relative path.**
  Pages serves from `/docs`, so a relative path to `../data/prices.csv` would
  404. Raw URL works regardless of Pages source config, and per-minute query
  param busts the CDN cache.

## Common operations

```powershell
# Run scraper locally (drops a row into data/prices.csv; reverts your local
# git working tree, doesn't push)
npm run track

# Dump rendered DOM for selector debugging if scraper output looks wrong
npm run discover
# → check scraper/dom_dump_*.{html,txt,png} (all gitignored)

# Trigger CI manually instead of waiting for cron
# UI: https://github.com/EthanAlong/ApartmentPriceTracking/actions
#     → "Track prices" → Run workflow
```

## Auth setup (Windows, per-folder identity)

This folder is under `C:\Users\Ethanh\personal\` which is configured via
`~/.gitconfig` `[includeIf "gitdir:..."]` to use the personal `EthanAlong`
identity. The work identity `SB-ATG` is the global default for everything
outside this tree.

Push credentials are scoped per-URL-path via `git config --local
credential.useHttpPath true` plus an OAuth credential stored by Git Credential
Manager at:
```
LegacyGeneric:target=git:https://github.com/EthanAlong/ApartmentPriceTracking.git
```
This entry was originally a leaked PAT (revoked), then re-generated via
browser OAuth flow. Token auto-refreshes. **Don't touch global git config or
credential.helper** — the per-path scoping is what keeps personal vs work
accounts from colliding.

## Current state (as of 2026-05-27)

- ✅ Scraper working end-to-end (41 units, 22 1-bed, 14 2-bed, 5 studio)
- ✅ CI runs 5x/day, commits CSV back with `[skip ci]`
- ✅ Dashboard live at https://ethanalong.github.io/ApartmentPriceTracking/
- ✅ Per-folder Git auth working (OAuth, not PAT)
- ⏸ Email notifications — **pending friend's confirmation**. Plan when
  unblocked: send via friend's own Gmail SMTP (Gmail user + app password +
  recipient as 3 repo secrets). Trigger only when target unit (1B1B 700-900
  sqft) prices change or new listings appear; silent otherwise. `nodemailer`
  + a new `scraper/notify_email.js` invoked from workflow after scrape step.

## Likely next features (in rough priority order)

1. **Email notifications** (see above, blocked on friend confirming).
2. **Diff view in dashboard** — highlight what changed vs previous scrape
   (price ↑↓, new listings, gone listings). Currently the chart shows
   trends but doesn't call out "this just happened".
3. **More properties** — generalize the scraper to take a property ID +
   URL via env vars or a config file. UDR uses the same template for all
   their properties (same `#unitListingContainer`, same `data-*` attrs),
   so this should be near-free.
4. **Concession / specials tracking** — UDR shows special offers ("1 month
   free", reduced deposits) per unit. Not in current CSV; would need
   another data attribute or text parse.
5. **DST-aware cron** — switch to a workflow that computes "30 min after
   6/9/12/15 PT" dynamically. Low value unless precision matters.
6. **Retention pruning** — if CSV crosses a few MB, drop rows older than N
   months in the workflow before commit.

## Origin story / debugging notes

The session that built this lived through a few worthwhile detours:

- Initial attempt parsed `document.body.innerText` with regex and only got
  15/22 expected units. Cause: page has "Recently Viewed" + filter UI that
  produces matching text outside the listings container. The fix was to
  read `data-*` attributes off `<li class="apartment">` elements inside
  `#unitListingContainer` — see also "Key design decisions" above.
- LOAD MORE was attempted but unnecessary; it only toggles a CSS class.
- Tried direct API endpoints (e.g., `/api/property/35245`, observed XHR
  calls during a Playwright session). UDR's prices aren't exposed via a
  clean JSON API — all the JSON endpoints we saw return amenities,
  chatbot config, or analytics. The pricing is server-rendered into the
  DOM with the data attributes. Playwright is the right tool here.
- Auth journey: PAT was pasted in chat → stored via GCM → user revoked PAT
  → next push failed → cleared cached cred → browser OAuth re-issued a
  new path-scoped credential. Final state is OAuth-based, no PAT.

## Cleanup if a future change goes wrong

```powershell
# Roll back to a known-good state
git log --oneline -10
git reset --hard <commit-sha>
git push --force-with-lease  # only if user explicitly OK with rewriting history

# Reset local credentials if push starts failing
cmdkey /delete:"LegacyGeneric:target=git:https://github.com/EthanAlong/ApartmentPriceTracking.git"
git push  # GCM will pop browser OAuth — sign in as EthanAlong
```
