// Refreshes public/data.json from the World Bank, IMF and currency-api.
// Run by the scheduled GitHub Action; also runnable locally: npm run build:data
// Exits non-zero (leaving the previous data.json untouched) if any check fails.

import { writeFile } from "node:fs/promises";
import { buildDataset, validateDataset } from "../public/sources.js";

const OUT = new URL("../public/data.json", import.meta.url);

const data = await buildDataset();
const problems = validateDataset(data);
if (problems.length) {
  console.error("Refusing to publish data.json:\n  - " + problems.join("\n  - "));
  process.exit(1);
}

// One country per line keeps the scheduled commits readable as diffs.
const { countries, ...meta } = data;
const body =
  JSON.stringify(meta, null, 2).replace(/\n}$/, ",\n") +
  '  "countries": [\n' +
  countries.map((c) => "    " + JSON.stringify(c)).join(",\n") +
  "\n  ]\n}\n";
JSON.parse(body); // guard against a formatting slip
await writeFile(OUT, body);

const flagged = countries.filter((c) => !c.fxOk).map((c) => c.id);
console.log(
  `data.json: ${countries.length} countries, PPP adjusted to ${data.targetYear}` +
    `${data.inflationAdjusted ? "" : " (IMF inflation unavailable, not adjusted)"}, FX ${data.fx.date}` +
    (flagged.length ? `\nMarket-rate figures hidden for: ${flagged.join(", ")}` : "")
);
