# Salary converter

What a salary is worth in another country once local prices are taken into account. Enter an amount and the country you earn it in; the map and list show the equivalent everywhere else, and how much more or less money the same lifestyle takes at today's exchange rate.

This replaces the earlier R Shiny app. It is a static site: no server, no R, and no runtime dependencies.

## How it works

```
GitHub Action (daily)                         Browser
──────────────────────                        ───────
World Bank PPP  ─┐                            index.html + app.js   14 KB
IMF inflation   ─┼─ scripts/build-data.mjs ─▶ data.json              6 KB
currency-api FX ─┘   (checks, then commits)   world.json            45 KB
                                              font (self-hosted)    41 KB
                                              ≈ 106 KB gzipped on first visit
                                              + live FX refresh if the snapshot is over a day old
```

- `public/sources.js`: fetches and combines the sources. The same module runs in Node (the scheduled build) and in the browser (fallback when `data.json` is missing).
- `scripts/build-data.mjs`: writes `public/data.json`. Refuses to overwrite it if fewer than 150 countries come back, US PPP isn't 1, or more than 30 countries fail the price-level check.
- `scripts/build-geo.mjs`: one-off. Converts Natural Earth 1:50m borders into simplified, pre-projected (Equal Earth) SVG paths, so the page needs no map library or tile server.
- `public/app.js`: all calculation and rendering. Plain JavaScript, no framework.
- `test/sources.test.mjs`: offline tests for the pipeline using synthetic fixtures.

## Data and method

| What | Source | Refresh |
|---|---|---|
| Price levels | World Bank WDI `PA.NUS.PRVT.PP`: PPP conversion factor for household consumption (falls back to `PA.NUS.PPP`, GDP basis, where missing) | Daily check; World Bank updates a few times a year |
| Bringing PPP up to date | IMF World Economic Outlook `PCPIPCH` (average CPI inflation, incl. current-year estimates) | Daily check; IMF updates April and October |
| Exchange rates and country → currency | [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) (free, no key, CORS-enabled) | Daily, and live in the browser |

- Equivalent local amount = amount × PPP(target) ÷ PPP(base)
- In your currency = equivalent ÷ FX(target) × FX(base)
- Cost ratio (map colour) = in your currency ÷ amount

World Bank PPPs lag one to two years. Each country's figure is rolled forward to the current year by the gap between its inflation and US inflation. This matters for high-inflation economies.

Currency overrides live in `CURRENCY_OVERRIDES` in `sources.js` (Croatia and Bulgaria → EUR, Venezuela → VES, Sierra Leone → SLE, Zimbabwe → ZWG). Countries whose implied price level falls outside 0.12–2.5× the US are flagged: their PPP equivalents still show, but market-rate comparisons are hidden. This usually means a redenomination the data hasn't caught up with, or an official rate far from the traded one (e.g. Lebanon).

## Deploy (GitHub Pages)

1. Move `ci/refresh-and-deploy.yml` to `.github/workflows/refresh-and-deploy.yml`, then push this folder to a GitHub repository (default branch `main`).
2. Settings → Pages → Source: **GitHub Actions**.
3. Actions → *Refresh data and deploy* → **Run workflow**. The first run creates `data.json` and publishes the site.

After that it runs daily on its own. Data commits also keep the repository active, so GitHub won't pause the schedule.

Any static host works (Netlify, Cloudflare Pages, S3): serve `public/` and run `npm run build:data` on a schedule.

## Local development

Requires Node 20+.

```
npm test             # pipeline tests, offline
npm run build:data   # fetch real data into public/data.json
npm run serve        # or: python -m http.server -d public 4173
```

Without a `data.json`, the page tries to build one in the browser from the same APIs. That depends on each API allowing cross-origin requests, so running `npm run build:data` first is the reliable path.

## Licences

Borders: Natural Earth (public domain). Font: Bricolage Grotesque, SIL Open Font License (`public/fonts/OFL.txt`). Data: World Bank (CC BY 4.0), IMF (IMF copyright and usage terms), exchange-api (CC0).
