// One-off build: Natural Earth 1:50m countries -> pre-projected, simplified SVG paths.
// Borders change rarely, so this is run by hand (npm run build:geo), not on the schedule.
// Output: public/world.json  { viewBox: [x, y, w, h], features: [{ id, name, a2?, d, m? }] }
// (m = dot position for countries too small to hover, a2 = ISO alpha-2 for locale defaults)
//
// Usage: node scripts/build-geo.mjs [path-to-local-geojson]

import { readFile, writeFile } from "node:fs/promises";

const SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson";
const OUT = new URL("../public/world.json", import.meta.url);

const WIDTH = 1000;        // SVG units across the full projected width
const TOLERANCE = 0.32;    // Douglas-Peucker tolerance in SVG units
const MIN_RING_AREA = 0.6; // drop islands smaller than this (SVG units²) unless they are a country's only land
const TINY_AREA = 6;       // countries smaller than this also get a clickable dot

// Readable names where Natural Earth's English name is formal or abbreviated.
const NAME_OVERRIDES = {
  USA: "United States", CHN: "China", COD: "DR Congo", COG: "Congo", MAC: "Macao",
  CZE: "Czechia", TLS: "Timor-Leste", CIV: "Côte d'Ivoire", CPV: "Cabo Verde",
  GMB: "Gambia", BHS: "Bahamas", VAT: "Vatican City", FSM: "Micronesia",
};
// Natural Earth codes that differ from the World Bank's.
const ID_OVERRIDES = { KOS: "XKX", SDS: "SSD", SAH: "ESH", PSX: "PSE" };
const DROP = new Set(["ATA", "ATF", "HMD", "SGS", "IOA", "ATC", "KAS", "CYN", "SOL", "BJN", "SER", "SCR", "CLP", "ESB", "WSB", "USG"]);

// Equal Earth projection (Šavrič, Patterson & Jenny, 2018).
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
function project([lon, lat]) {
  const l = (lon * Math.PI) / 180, p = (lat * Math.PI) / 180;
  const t = Math.asin(M * Math.sin(p)), t2 = t * t, t6 = t2 * t2 * t2;
  const x = (l * Math.cos(t)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  const y = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  return [x, -y];
}
const XMAX = project([180, 0])[0];
const SCALE = WIDTH / (2 * XMAX);
const toSvg = (pt) => { const [x, y] = project(pt); return [x * SCALE, y * SCALE]; };

function simplify(points, tol) {
  if (points.length <= 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let max = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let d2;
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > max) { max = d2; idx = i; }
    }
    if (max > tol2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

const area = (ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(s / 2);
};
const r1 = (n) => Math.round(n * 10) / 10;

function ringToPath(ring) {
  const pts = [];
  for (const p of ring) {
    const q = [r1(p[0]), r1(p[1])];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
  }
  if (pts.length < 3) return "";
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    d += `l${r1(pts[i][0] - pts[i - 1][0])} ${r1(pts[i][1] - pts[i - 1][1])}`;
  }
  return d + "z";
}

const raw = process.argv[2]
  ? await readFile(process.argv[2], "utf8")
  : await (await fetch(SOURCE)).text();
const geo = JSON.parse(raw);

const byId = new Map();
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

for (const f of geo.features) {
  const p = f.properties;
  const ne = p.ADM0_A3;
  if (DROP.has(ne)) continue;
  let id = p.ISO_A3_EH && p.ISO_A3_EH !== "-99" ? p.ISO_A3_EH : ne;
  id = ID_OVERRIDES[ne] || ID_OVERRIDES[id] || id;
  const name = NAME_OVERRIDES[id] || p.NAME_EN || p.NAME;
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;

  const rings = [];
  for (const poly of polys) {
    poly.forEach((ring, k) => {
      const projected = ring.map(toSvg);
      rings.push({ pts: projected, a: area(projected), hole: k > 0 });
    });
  }
  const a2 = p.ISO_A2_EH && p.ISO_A2_EH !== "-99" ? p.ISO_A2_EH : null;
  const entry = byId.get(id) || { id, name, a2, rings: [], label: null };
  entry.rings.push(...rings);
  if (!entry.label && p.LABEL_X != null) entry.label = toSvg([p.LABEL_X, p.LABEL_Y]);
  byId.set(id, entry);
}

const features = [];
for (const e of byId.values()) {
  const largest = Math.max(...e.rings.filter((r) => !r.hole).map((r) => r.a));
  const total = e.rings.filter((r) => !r.hole).reduce((s, r) => s + r.a, 0);
  let d = "";
  for (const r of e.rings) {
    if (r.a < MIN_RING_AREA && r.a !== largest) continue;
    const s = simplify(r.pts, r.a < 20 ? TOLERANCE / 3 : TOLERANCE);
    d += ringToPath(s);
    for (const [x, y] of s) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const feature = { id: e.id, name: e.name, d };
  if (e.a2) feature.a2 = e.a2;
  if (total < TINY_AREA && e.label) feature.m = [r1(e.label[0]), r1(e.label[1])];
  features.push(feature);
}
features.sort((a, b) => a.name.localeCompare(b.name));

const pad = 4;
const viewBox = [r1(minX - pad), r1(minY - pad), r1(maxX - minX + 2 * pad), r1(maxY - minY + 2 * pad)];
const json = JSON.stringify({ viewBox, features });
await writeFile(OUT, json);
console.log(`world.json: ${features.length} countries, ${(json.length / 1024).toFixed(0)} KB, viewBox ${viewBox.join(" ")}`);
