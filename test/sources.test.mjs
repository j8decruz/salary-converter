// Offline tests for the data pipeline, using synthetic fixtures (not real figures).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, validateDataset } from "../public/sources.js";

const wbRow = (iso3, name, value, date = "2024") => ({
  countryiso3code: iso3, country: { id: iso3.slice(0, 2), value: name }, date, value,
});

function mockFetch(overrides = {}) {
  const prvt = [
    wbRow("USA", "United States", 1),
    wbRow("THA", "Thailand", 10),
    wbRow("HRV", "Croatia", 0.5),
    wbRow("LBN", "Lebanon", 1500),
    wbRow("EAS", "East Asia & Pacific", 5), // aggregate, must be dropped
  ];
  const gdp = [...prvt, wbRow("IND", "India", 20, "2023")];
  const responses = {
    "PA.NUS.PRVT.PP": [{ page: 1 }, prvt],
    "PA.NUS.PPP": [{ page: 1 }, gdp],
    "country.json": {
      us: { country_iso3: "usa", currency_code: "usd" },
      th: { country_iso3: "tha", currency_code: "thb" },
      hr: { country_iso3: "hrv", currency_code: "hrk" },
      lb: { country_iso3: "lbn", currency_code: "lbp" },
      in: { country_iso3: "ind", currency_code: "inr" },
    },
    "usd.min.json": { date: "2026-11-19", usd: { usd: 1, thb: 34, eur: 0.9, hrk: 6.9, lbp: 89500, inr: 90 } },
    PCPIPCH: { values: { PCPIPCH: {
      USA: { 2024: 3, 2025: 3, 2026: 2.5 },
      THA: { 2025: 1, 2026: 1.5 },
      IND: { 2024: 5, 2025: 4 }, // 2026 missing: roll forward stops at 2025
    } } },
    ...overrides,
  };
  return async (url) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    const body = responses[key];
    if (body instanceof Error) return { ok: false, status: 503, statusText: "Unavailable", json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
}

const now = new Date("2026-11-20T00:00:00Z");

test("rolls PPP forward with the inflation gap to the US", async () => {
  const d = await buildDataset({ fetch: mockFetch(), now });
  const tha = d.countries.find((c) => c.id === "THA");
  assert.equal(tha.year, 2024);
  assert.equal(tha.adj, 2026);
  assert.ok(Math.abs(tha.ppp - 10 * (1.01 / 1.03) * (1.015 / 1.025)) < 1e-4);
  assert.equal(d.countries.find((c) => c.id === "USA").ppp, 1);
});

test("stops rolling forward when a year of inflation is missing", async () => {
  const d = await buildDataset({ fetch: mockFetch(), now });
  const ind = d.countries.find((c) => c.id === "IND");
  assert.equal(ind.basis, "gdp");
  assert.equal(ind.adj, 2025);
  assert.ok(Math.abs(ind.ppp - 20 * (1.05 / 1.03) * (1.04 / 1.03)) < 1e-4);
});

test("drops aggregates, applies currency overrides, flags inconsistent rates", async () => {
  const d = await buildDataset({ fetch: mockFetch(), now });
  assert.ok(!d.countries.some((c) => c.id === "EAS"));
  assert.equal(d.countries.find((c) => c.id === "HRV").cur, "EUR");
  assert.equal(d.countries.find((c) => c.id === "LBN").fxOk, false);
  assert.equal(d.countries.find((c) => c.id === "THA").fxOk, true);
  assert.equal(d.fx.rates.EUR, 0.9);
  assert.equal(d.fx.rates.HRK, undefined);
});

test("keeps going without IMF data, unadjusted", async () => {
  const d = await buildDataset({ fetch: mockFetch({ PCPIPCH: new Error("down") }), now });
  assert.equal(d.inflationAdjusted, false);
  const tha = d.countries.find((c) => c.id === "THA");
  assert.equal(tha.adj, 2024);
  assert.equal(tha.ppp, 10);
});

test("fails loudly when the World Bank is down", async () => {
  await assert.rejects(buildDataset({ fetch: mockFetch({ "PA.NUS.PRVT.PP": new Error("down") }), now }));
});

test("validation rejects a thin dataset", async () => {
  const d = await buildDataset({ fetch: mockFetch(), now });
  assert.ok(validateDataset(d).some((p) => p.includes("countries")));
});
