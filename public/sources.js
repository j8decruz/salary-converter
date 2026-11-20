// Fetches and combines the three public data sources into one small dataset.
// Runs unchanged in Node 18+ (scripts/build-data.mjs, on a schedule) and in the
// browser (fallback when data.json is missing). No dependencies.
//
//   PPP        World Bank WDI, PA.NUS.PRVT.PP: PPP conversion factor for private
//              consumption, LCU per international $ (falls back to PA.NUS.PPP, GDP basis)
//   Inflation  IMF World Economic Outlook, PCPIPCH: average consumer-price inflation,
//              used to roll each country's PPP forward from its latest benchmark year
//   FX + map   fawazahmed0/currency-api: daily market rates per USD and the
//              country -> currency mapping

const WB = (indicator) =>
  `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&mrnev=1&per_page=500`;
const IMF = (years) =>
  `https://www.imf.org/external/datamapper/api/v1/PCPIPCH?periods=${years.join(",")}`;
export const FX_URLS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
];
const COUNTRY_URLS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/country.json",
  "https://latest.currency-api.pages.dev/v1/country.json",
];

// Currency changes the country map has not caught up with. Each entry is the
// currency the World Bank now reports that country's PPP in.
export const CURRENCY_OVERRIDES = {
  HRV: "eur", // euro since Jan 2023
  BGR: "eur", // euro since Jan 2026
  VEN: "ves", // bolívar soberano since 2018
  SLE: "sle", // new leone since 2022
  ZWE: "zwg", // ZiG since Apr 2024
  XKX: "eur", // Kosovo
  PSE: "ils", // West Bank and Gaza
};
// IMF codes that differ from ISO/World Bank.
const IMF_CODES = { UVK: "XKX", WBG: "PSE" };

// A price level (PPP / market rate, relative to the US) outside this band almost
// always means the PPP and the market rate are in different currency units, or the
// official rate is far from the traded one. PPP-only figures stay valid; figures
// that need the market rate are hidden for these countries.
export const PRICE_LEVEL_BAND = [0.12, 2.5];

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function firstOk(urls, fetchImpl) {
  let last;
  for (const u of urls) {
    try { return await getJson(u, fetchImpl); } catch (e) { last = e; }
  }
  throw last;
}

function worldBankRows(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) {
    const msg = payload?.[0]?.message?.[0]?.value;
    throw new Error(`Unexpected World Bank response${msg ? `: ${msg}` : ""}`);
  }
  return payload[1].filter((r) => r.value != null && r.countryiso3code);
}

export async function fetchFx(fetchImpl = fetch) {
  const fx = await firstOk(FX_URLS, fetchImpl);
  if (!fx?.usd || !fx.date) throw new Error("Unexpected currency-api response");
  return { date: fx.date, rates: fx.usd };
}

export async function buildDataset({ fetch: fetchImpl = fetch, now = new Date() } = {}) {
  const targetYear = now.getUTCFullYear();
  const imfYears = [];
  for (let y = targetYear - 8; y <= targetYear; y++) imfYears.push(y);

  const [prvt, gdp, countryMap, fx, imf] = await Promise.all([
    getJson(WB("PA.NUS.PRVT.PP"), fetchImpl).then(worldBankRows),
    getJson(WB("PA.NUS.PPP"), fetchImpl).then(worldBankRows),
    firstOk(COUNTRY_URLS, fetchImpl),
    fetchFx(fetchImpl),
    // Inflation only refines the result; carry on without it if the IMF is down.
    getJson(IMF(imfYears), fetchImpl).catch((e) => ({ error: String(e.message || e) })),
  ]);

  // ISO3 -> currency code, from the country map plus overrides.
  const currencyOf = {};
  for (const c of Object.values(countryMap)) {
    if (c.country_iso3 && c.currency_code) currencyOf[c.country_iso3.toUpperCase()] = c.currency_code.toLowerCase();
  }
  Object.assign(currencyOf, CURRENCY_OVERRIDES);

  // Inflation by ISO3 and year.
  const inflation = {};
  const imfValues = imf?.values?.PCPIPCH || {};
  for (const [code, series] of Object.entries(imfValues)) inflation[IMF_CODES[code] || code] = series;
  const usInflation = inflation.USA || {};

  // Latest PPP per country: private consumption first, GDP basis as fallback.
  // Only real countries have a currency, so regional aggregates drop out here.
  const latest = new Map();
  for (const [rows, basis] of [[gdp, "gdp"], [prvt, "consumption"]]) {
    for (const r of rows) {
      const id = r.countryiso3code;
      if (!currencyOf[id]) continue;
      latest.set(id, { id, name: r.country?.value, ppp: r.value, year: Number(r.date), basis });
    }
  }

  const countries = [];
  for (const c of latest.values()) {
    // Roll forward: PPP grows with the inflation gap between the country and the US.
    let ppp = c.ppp, adjustedTo = c.year;
    for (let y = c.year + 1; y <= targetYear; y++) {
      const pi = inflation[c.id]?.[y], piUs = usInflation[y];
      if (pi == null || piUs == null) break;
      ppp *= (1 + pi / 100) / (1 + piUs / 100);
      adjustedTo = y;
    }
    const cur = currencyOf[c.id];
    const rate = fx.rates[cur];
    const priceLevel = rate ? ppp / rate : null;
    const fxOk = priceLevel != null && priceLevel >= PRICE_LEVEL_BAND[0] && priceLevel <= PRICE_LEVEL_BAND[1];
    countries.push({
      id: c.id,
      name: c.name,
      cur: cur.toUpperCase(),
      ppp: Number(ppp.toPrecision(6)),
      year: c.year,
      adj: adjustedTo,
      basis: c.basis,
      fxOk,
    });
  }
  countries.sort((a, b) => a.id.localeCompare(b.id));

  const used = new Set(countries.map((c) => c.cur.toLowerCase()));
  const rates = {};
  for (const k of used) if (fx.rates[k] != null) rates[k.toUpperCase()] = Number(fx.rates[k].toPrecision(8));

  return {
    generated: now.toISOString(),
    targetYear,
    inflationAdjusted: !imf.error,
    notes: imf.error ? [`IMF inflation unavailable: ${imf.error}`] : [],
    fx: { date: fx.date, rates },
    countries,
  };
}

// Checks a dataset before it replaces the published one.
export function validateDataset(d) {
  const problems = [];
  if (!d?.countries || d.countries.length < 150) problems.push(`only ${d?.countries?.length ?? 0} countries`);
  const us = d?.countries?.find((c) => c.id === "USA");
  if (!us) problems.push("United States missing");
  else if (Math.abs(us.ppp - 1) > 0.02) problems.push(`US PPP is ${us.ppp}, expected 1`);
  if (!d?.fx?.rates?.EUR) problems.push("EUR rate missing");
  const unreliable = d?.countries?.filter((c) => !c.fxOk).length ?? 0;
  if (unreliable > 30) problems.push(`${unreliable} countries fail the price-level check`);
  return problems;
}
