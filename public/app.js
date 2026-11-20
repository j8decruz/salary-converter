// Salary converter: all calculation happens here, in the browser.
// equivalent local amount = amount × PPP(target) / PPP(base)
// in base currency        = equivalent local amount ÷ FX(target) × FX(base)
// cost ratio              = in base currency ÷ amount   (1 = same cost of living)

const $ = (sel) => document.querySelector(sel);
const SVGNS = "http://www.w3.org/2000/svg";
const PRICE_LEVEL_BAND = [0.12, 2.5]; // keep in step with sources.js

// Diverging bins on the cost ratio: four cheaper, neutral, four pricier.
const BREAKS = [0.4, 0.55, 0.7, 0.87, 1.15, 1.4, 1.8, 2.5];
const BIN_VARS = ["--c4", "--c3", "--c2", "--c1", "--n0", "--p1", "--p2", "--p3", "--p4"];
const binOf = (r) => { let i = 0; while (i < BREAKS.length && r >= BREAKS[i]) i++; return i; };
const pct = (r) => { const p = Math.round((r - 1) * 100); return p === 0 ? "0%" : `${p > 0 ? "+" : "−"}${Math.abs(p)}%`; };

const state = {
  countries: new Map(), // id -> { id, name, cur, ppp, year, adj, basis, fxOk }
  rates: {},            // currency -> units per USD
  meta: null,
  world: null,
  base: null,
  target: null,
  amount: 100000,
  sort: "cheap",
  filter: "",
  showAll: false,
};

/* ---------- formatting ---------- */

const fmtCache = new Map();
function money(value, cur, { compact = false, sig = 3 } = {}) {
  if (value == null || !isFinite(value)) return "–";
  const key = `${cur}|${compact}|${sig}`;
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat("en", {
        style: "currency", currency: cur, currencyDisplay: "symbol",
        maximumSignificantDigits: sig, notation: compact ? "compact" : "standard",
      });
    } catch {
      const n = new Intl.NumberFormat("en", { maximumSignificantDigits: sig, notation: compact ? "compact" : "standard" });
      f = { format: (v) => `${cur} ${n.format(v)}` };
    }
    fmtCache.set(key, f);
  }
  return f.format(value);
}
const plain = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const currencyName = (() => {
  let dn;
  try { dn = new Intl.DisplayNames(["en"], { type: "currency" }); } catch {}
  return (code) => { try { return dn?.of(code) || code; } catch { return code; } };
})();

function parseAmount(text) {
  const t = String(text).trim().toLowerCase().replace(/[,\s_]/g, "");
  const m = t.match(/^(\d*\.?\d+)([km])?$/);
  if (!m) return null;
  const v = parseFloat(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
  return v > 0 && v < 1e15 ? v : null;
}

/* ---------- maths ---------- */

function fxUsable(c) {
  const rate = state.rates[c.cur];
  return Boolean(c.fxOk && rate);
}
function compute(c) {
  const b = state.base;
  const local = (state.amount * c.ppp) / b.ppp;
  let inBase = null, ratio = null;
  if (fxUsable(c) && fxUsable(b)) {
    inBase = (local / state.rates[c.cur]) * state.rates[b.cur];
    ratio = inBase / state.amount;
  }
  return { local, inBase, ratio };
}

/* ---------- data loading ---------- */

async function getJson(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function loadData() {
  try {
    return await getJson("data.json");
  } catch {
    // No published snapshot (first run, or local preview): build it in the browser.
    setStatus("Fetching the latest figures from the World Bank and IMF…");
    const { buildDataset } = await import("./sources.js");
    return buildDataset();
  }
}

async function refreshFx() {
  const today = new Date().toISOString().slice(0, 10);
  if (state.meta.fx.date >= today) return;
  try {
    const { fetchFx } = await import("./sources.js");
    const fx = await Promise.race([fetchFx(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))]);
    if (fx.date <= state.meta.fx.date) return;
    for (const c of state.countries.values()) {
      const rate = fx.rates[c.cur.toLowerCase()];
      if (!rate) continue;
      state.rates[c.cur] = rate;
      const level = c.ppp / rate;
      c.fxOk = level >= PRICE_LEVEL_BAND[0] && level <= PRICE_LEVEL_BAND[1];
    }
    state.meta.fx.date = fx.date;
    render();
  } catch {
    // Keep the published rates; the footer shows their date.
  }
}

function setStatus(text) {
  const el = $("#status");
  el.hidden = !text;
  el.textContent = text || "";
}

/* ---------- map ---------- */

const view = { k: 1, x: 0, y: 0 };
let svg, viewport, outlines, paths = new Map();

function buildMap() {
  svg = $("#map");
  const [vx, vy, vw, vh] = state.world.viewBox;
  svg.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.innerHTML = `
    <defs>
      <pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
        <rect width="3" height="3" fill="var(--nodata)"/><rect width="1" height="3" fill="var(--nodata-hatch)"/>
      </pattern>
    </defs>
    <g id="viewport"><g id="lands"></g><g id="dots"></g><g id="outlines"></g></g>`;
  viewport = svg.querySelector("#viewport");
  outlines = svg.querySelector("#outlines");
  const lands = svg.querySelector("#lands"), dots = svg.querySelector("#dots");
  for (const f of state.world.features) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", f.d);
    p.setAttribute("class", "land");
    p.setAttribute("id", `p-${f.id}`);
    p.dataset.id = f.id;
    lands.appendChild(p);
    const els = [p];
    if (f.m) {
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", f.m[0]);
      c.setAttribute("cy", f.m[1]);
      c.setAttribute("r", 2.2);
      c.setAttribute("class", "land dot");
      c.dataset.id = f.id;
      dots.appendChild(c);
      els.push(c);
    }
    paths.set(f.id, els);
  }
  wireMapInteraction();
}

function paintMap() {
  for (const [id, els] of paths) {
    const c = state.countries.get(id);
    const r = c && state.base ? compute(c).ratio : null;
    for (const el of els) {
      if (r == null) { el.classList.add("nodata"); el.style.fill = ""; }
      else { el.classList.remove("nodata"); el.style.fill = `var(${BIN_VARS[binOf(r)]})`; }
    }
  }
  outlines.innerHTML = "";
  const marks = [[state.base, "outline base"]];
  if (state.target && state.target !== state.base) marks.push([state.target, "outline"]);
  for (const [c, cls] of marks) {
    if (!c || !paths.has(c.id)) continue;
    const [shape, dot] = paths.get(c.id);
    const u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", `#p-${c.id}`);
    u.setAttribute("class", cls);
    outlines.appendChild(u);
    if (dot) {
      const ring = document.createElementNS(SVGNS, "circle");
      ring.setAttribute("cx", dot.getAttribute("cx"));
      ring.setAttribute("cy", dot.getAttribute("cy"));
      ring.setAttribute("r", 3.6 / Math.sqrt(view.k));
      ring.setAttribute("class", cls + " ring");
      outlines.appendChild(ring);
    }
  }
}

function applyView() {
  viewport.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
  // Dots shrink more slowly than the land around them, so they stay findable.
  const r = 2.2 / Math.sqrt(view.k);
  for (const els of paths.values()) if (els[1]) els[1].setAttribute("r", r);
  outlines?.querySelectorAll(".ring").forEach((c) => c.setAttribute("r", 3.6 / Math.sqrt(view.k)));
}

function clampView() {
  // Content spans the viewBox; when zoomed in it must keep covering the frame.
  const [vx, vy, vw, vh] = state.world.viewBox;
  view.k = Math.min(16, Math.max(1, view.k));
  view.x = Math.min(vx * (1 - view.k), Math.max((vx + vw) * (1 - view.k), view.x));
  view.y = Math.min(vy * (1 - view.k), Math.max((vy + vh) * (1 - view.k), view.y));
}

function zoomAt(factor, sx, sy) {
  const k = Math.min(16, Math.max(1, view.k * factor));
  const f = k / view.k;
  view.x = sx - (sx - view.x) * f;
  view.y = sy - (sy - view.y) * f;
  view.k = k;
  clampView();
  applyView();
}

function svgPoint(clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function wireMapInteraction() {
  const tip = $("#tooltip");
  const pane = $("#map-pane");
  const pointers = new Map();
  let drag = null, pinch = null, moved = 0;

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = svgPoint(e.clientX, e.clientY);
    zoomAt(Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0018)))), p.x, p.y);
  }, { passive: false });

  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, svgPoint(e.clientX, e.clientY));
    moved = 0;
    if (pointers.size === 1) {
      const p = pointers.get(e.pointerId);
      drag = { x: p.x, y: p.y, vx: view.x, vy: view.y, cx: e.clientX, cy: e.clientY };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
      drag = null;
    }
  });
  svg.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) {
      const p = svgPoint(e.clientX, e.clientY);
      pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt((pinch.k * (d / pinch.d)) / view.k, (a.x + b.x) / 2, (a.y + b.y) / 2);
        moved = 99;
      } else if (drag) {
        moved = Math.max(moved, Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy));
        if (moved > 3) {
          svg.classList.add("dragging");
          view.x = drag.vx + (p.x - drag.x);
          view.y = drag.vy + (p.y - drag.y);
          clampView();
          applyView();
          // Coordinates shift as the view moves; re-anchor the drag.
          drag = { ...drag, x: p.x, y: p.y, vx: view.x, vy: view.y };
        }
      }
      tip.hidden = true;
      return;
    }
    showTip(e);
  });
  const end = (e) => {
    const wasClick = pointers.size === 1 && moved <= 3;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { drag = null; svg.classList.remove("dragging"); }
    if (wasClick && e.type === "pointerup") {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const id = el?.dataset?.id;
      if (id && state.countries.has(id)) {
        setTarget(id, { reveal: true });
        showTip({ target: el, clientX: e.clientX, clientY: e.clientY });
      }
    }
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; svg.querySelector(".hover-outline")?.remove(); });

  function showTip(e) {
    const id = e.target?.dataset?.id;
    svg.querySelector(".hover-outline")?.remove();
    if (!id) { tip.hidden = true; return; }
    const name = state.countries.get(id)?.name || state.world.features.find((f) => f.id === id)?.name || id;
    const c = state.countries.get(id);
    let html = `<b>${escapeHtml(name)}</b>`;
    if (!c) html += `<span class="muted">No price data</span>`;
    else if (c === state.base) html += `<span class="muted">Your country</span>`;
    else {
      const r = compute(c);
      html += `${money(r.local, c.cur)}`;
      html += r.inBase != null
        ? `<br><span class="muted">≈ ${money(r.inBase, state.base.cur)} · ${costPhrase(r.ratio)}</span>`
        : `<br><span class="muted">No reliable market rate</span>`;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const box = pane.getBoundingClientRect();
    let x = e.clientX - box.left, y = e.clientY - box.top;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w + 24 > box.width) x -= w + 24;
    if (y + h + 24 > box.height) y -= h + 24;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    if (e.target.tagName === "path") {
      const u = document.createElementNS(SVGNS, "use");
      u.setAttribute("href", `#p-${id}`);
      u.setAttribute("class", "hover-outline");
      outlines.appendChild(u);
    }
  }

  const center = () => { const [vx, vy, vw, vh] = state.world.viewBox; return [vx + vw / 2, vy + vh / 2]; };
  $("#zoom-in").addEventListener("click", () => zoomAt(1.6, ...center()));
  $("#zoom-out").addEventListener("click", () => zoomAt(1 / 1.6, ...center()));
  $("#zoom-reset").addEventListener("click", () => { view.k = 1; view.x = 0; view.y = 0; applyView(); });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function costPhrase(r) {
  if (r == null) return "";
  if (Math.abs(r - 1) < 0.03) return "about the same cost";
  return r < 1 ? `${Math.round((1 - r) * 100)}% cheaper` : `${Math.round((r - 1) * 100)}% pricier`;
}

/* ---------- legend ---------- */

function renderLegend() {
  const el = $("#legend");
  if (!state.base || !fxUsable(state.base)) {
    el.innerHTML = `<p class="title">Shading needs a reliable market rate for ${escapeHtml(state.base?.cur || "")}.</p>
      <div class="nd"><i></i>Equivalent amounts in the list still apply</div>`;
    return;
  }
  const ticks = BREAKS.map((b, i) => `<span style="left:${((i + 1) / BIN_VARS.length) * 100}%">${pct(b)}</span>`).join("");
  el.innerHTML = `
    <p class="title">Cost of the same lifestyle vs. ${escapeHtml(state.base.name)}</p>
    <div class="key">
      <div class="scale">${BIN_VARS.map((v) => `<span style="background:var(${v})"></span>`).join("")}</div>
      <div class="ticks">${ticks}</div>
    </div>
    <div class="nd"><i></i>No data or no reliable exchange rate</div>`;
}

/* ---------- result ---------- */

function renderResult() {
  const el = $("#result");
  const b = state.base, t = state.target;
  if (!b) { el.innerHTML = ""; return; }
  if (!t || t === b) {
    el.innerHTML = `<p class="prompt">Pick a country on the map or in the list to see what the same salary is worth there.</p>`;
    return;
  }
  const r = compute(t);
  const years = t.adj > t.year ? `${t.year} prices, adjusted to ${t.adj} for inflation` : `${t.year} prices`;
  let compare;
  if (r.inBase != null) {
    const bin = binOf(r.ratio);
    compare = `That's <b>${money(r.inBase, b.cur)}</b> at today's exchange rate. ` +
      `<span class="swatch-inline" style="background:var(${BIN_VARS[bin]})"></span>` +
      `The same lifestyle is <b>${costPhrase(r.ratio)}</b> than in ${escapeHtml(b.name)}.`;
    if (Math.abs(r.ratio - 1) < 0.03) compare = `That's <b>${money(r.inBase, b.cur)}</b> at today's exchange rate: about the same cost as ${escapeHtml(b.name)}.`;
  } else {
    compare = `A market exchange-rate comparison isn't shown: ${escapeHtml(t.fxOk ? b.name : t.name)}'s official rate and local prices don't line up, usually because of a currency redenomination or a parallel market rate.`;
  }
  el.innerHTML = `
    <p class="lead">To live as well in <strong>${escapeHtml(t.name)}</strong>, you'd need</p>
    <p class="figure">${money(r.local, t.cur)}</p>
    <p class="compare">${compare}</p>
    <p class="caveat">${currencyName(t.cur)} · ${years}${t.basis === "gdp" ? " · GDP-based PPP (consumer prices unavailable)" : ""}. Rounded to 3 significant figures; pre-tax.</p>`;
}

/* ---------- list ---------- */

function renderList() {
  const ol = $("#rows");
  const q = state.filter.trim().toLowerCase();
  const items = [];
  for (const c of state.countries.values()) {
    if (c === state.base) continue;
    if (q && !c.name.toLowerCase().includes(q) && !c.cur.toLowerCase().includes(q)) continue;
    items.push({ c, r: compute(c) });
  }
  const byName = (a, b) => a.c.name.localeCompare(b.c.name);
  const byRatio = (dir) => (a, b) => {
    if (a.r.ratio == null && b.r.ratio == null) return byName(a, b);
    if (a.r.ratio == null) return 1;
    if (b.r.ratio == null) return -1;
    return dir * (a.r.ratio - b.r.ratio);
  };
  items.sort(state.sort === "name" ? byName : byRatio(state.sort === "cheap" ? 1 : -1));

  const LIMIT = 25;
  const capped = !q && !state.showAll && items.length > LIMIT + 5;
  const shown = capped ? items.slice(0, LIMIT) : items;
  // Keep the selected country visible even when the list is shortened.
  if (capped && state.target && !shown.some((x) => x.c === state.target)) {
    const sel = items.find((x) => x.c === state.target);
    if (sel) shown.push(sel);
  }
  const more = $("#more");
  more.hidden = !capped;
  more.textContent = `Show all ${items.length} countries`;

  const frag = document.createDocumentFragment();
  for (const { c, r } of shown) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row";
    btn.dataset.id = c.id;
    if (c === state.target) btn.setAttribute("aria-current", "true");
    let bar = "";
    if (r.ratio != null) {
      const v = Math.max(-1.5, Math.min(1.5, Math.log2(r.ratio))) / 1.5 * 50;
      const left = v < 0 ? 50 + v : 50, width = Math.max(1.5, Math.abs(v));
      bar = `<span style="left:${left}%;width:${width}%;background:var(${BIN_VARS[binOf(r.ratio)]})"></span>`;
    }
    btn.innerHTML = `
      <span class="name">${escapeHtml(c.name)}<small>${c.cur}</small></span>
      <span class="bar" aria-hidden="true">${bar}</span>
      <span class="val">${money(r.local, c.cur, { compact: r.local >= 1e6 })}<small>${r.inBase != null ? `≈ ${money(r.inBase, state.base.cur, { compact: r.inBase >= 1e6 })}` : "no market rate"}</small></span>`;
    btn.setAttribute("aria-label", `${c.name}: ${money(r.local, c.cur)}${r.ratio != null ? `, ${costPhrase(r.ratio)}` : ""}`);
    li.appendChild(btn);
    frag.appendChild(li);
  }
  ol.replaceChildren(frag);
  if (!items.length) ol.innerHTML = `<li class="row" style="cursor:default;color:var(--ink-3)">No country matches “${escapeHtml(state.filter)}”.</li>`;
}

/* ---------- sources ---------- */

function renderSources() {
  const m = state.meta;
  const years = {};
  for (const c of state.countries.values()) years[c.year] = (years[c.year] || 0) + 1;
  const benchmark = Object.entries(years).sort((a, b) => b[1] - a[1])[0]?.[0];
  const adjusted = m.inflationAdjusted
    ? `, rolled forward to ${m.targetYear} with <a href="https://www.imf.org/external/datamapper/PCPIPCH@WEO">IMF inflation estimates</a>`
    : "";
  $("#sources").innerHTML = `
    <p>Prices: <a href="https://data.worldbank.org/indicator/PA.NUS.PRVT.PP">World Bank PPP for household consumption</a> (mostly ${benchmark})${adjusted}.
    Exchange rates: market rates for ${dateFmt.format(new Date(m.fx.date + "T00:00:00Z"))} via <a href="https://github.com/fawazahmed0/exchange-api">currency-api</a>.</p>
    <details>
      <summary>How this is calculated</summary>
      <p>Purchasing power parity (PPP) says how many units of each currency buy the same basket of household goods and services. The equivalent salary is your amount × the target country's PPP ÷ your country's PPP.</p>
      <p>Converting that back at the market exchange rate shows how much more or less money the same lifestyle takes. PPP reflects typical local spending, not an expat basket (international schools, imported goods, prime-area rent), and ignores taxes.</p>
    </details>`;
}

/* ---------- inputs ---------- */

const measureCtx = document.createElement("canvas").getContext("2d");
function sizeInput(input, text, minPx = 40) {
  const cs = getComputedStyle(input);
  measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const w = measureCtx.measureText(text).width * 1.02 + 4;
  input.style.width = `${Math.max(minPx, Math.ceil(w))}px`;
}

function setBase(id) {
  const c = state.countries.get(id);
  if (!c) return;
  state.base = c;
  if (state.target === c) state.target = null;
  const input = $("#base");
  input.value = c.name;
  sizeInput(input, c.name);
  $("#amount-unit").textContent = c.cur;
  render();
}

function setTarget(id, { reveal = false } = {}) {
  const c = state.countries.get(id);
  if (!c || c === state.base) return;
  state.target = c;
  renderResult();
  paintMap();
  for (const b of document.querySelectorAll(".row[aria-current]")) b.removeAttribute("aria-current");
  document.querySelector(`.row[data-id="${id}"]`)?.setAttribute("aria-current", "true");
  saveUrl();
  if (reveal && matchMedia("(max-width: 900px)").matches) {
    $("#result").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  }
}

function wireAmount() {
  const input = $("#amount");
  const update = () => {
    const v = parseAmount(input.value);
    input.setAttribute("aria-invalid", v == null ? "true" : "false");
    sizeInput(input, input.value || "0");
    if (v == null) return;
    state.amount = v;
    render();
  };
  let t;
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(update, 120); });
  input.addEventListener("blur", () => {
    const v = parseAmount(input.value);
    if (v != null) input.value = plain.format(v);
    else input.value = plain.format(state.amount);
    sizeInput(input, input.value);
    input.setAttribute("aria-invalid", "false");
  });
  input.addEventListener("focus", () => input.select());
}

function wireCombobox() {
  const input = $("#base"), list = $("#base-list");
  let options = [], active = -1;

  const open = () => { list.hidden = false; input.setAttribute("aria-expanded", "true"); };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; };
  const fill = (q) => {
    const s = q.trim().toLowerCase();
    options = [...state.countries.values()]
      .filter((c) => !s || c.name.toLowerCase().includes(s) || c.cur.toLowerCase() === s)
      .sort((a, b) => {
        const as = a.name.toLowerCase().startsWith(s), bs = b.name.toLowerCase().startsWith(s);
        return as === bs ? a.name.localeCompare(b.name) : as ? -1 : 1;
      });
    list.innerHTML = options.length
      ? options.map((c, i) => `<li role="option" id="opt-${c.id}" data-id="${c.id}" aria-selected="${i === active}"><span>${escapeHtml(c.name)}</span><span class="cur">${c.cur}</span></li>`).join("")
      : `<li class="empty" role="option" aria-disabled="true">No match</li>`;
  };
  const highlight = (i) => {
    active = Math.max(0, Math.min(options.length - 1, i));
    list.querySelectorAll("[role=option]").forEach((li, j) => li.setAttribute("aria-selected", String(j === active)));
    const li = list.children[active];
    if (li) {
      input.setAttribute("aria-activedescendant", li.id);
      // Scroll inside the list only; scrollIntoView would move the whole page.
      if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
      else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
    }
  };
  const choose = (id) => { close(); setBase(id); saveUrl(); input.blur(); };

  input.addEventListener("focus", () => { input.select(); fill(""); open(); });
  input.addEventListener("input", () => { sizeInput(input, input.value || " "); fill(input.value); open(); highlight(0); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) { fill(""); open(); } highlight(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (options[active] || options[0]) choose((options[active] || options[0]).id); }
    else if (e.key === "Escape") { close(); input.value = state.base.name; sizeInput(input, input.value); input.blur(); }
  });
  input.addEventListener("blur", () => setTimeout(() => {
    close();
    input.value = state.base?.name || "";
    sizeInput(input, input.value);
  }, 120));
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => { const id = e.target.closest("[data-id]")?.dataset.id; if (id) choose(id); });
  $("#base-slot").addEventListener("click", () => input.focus());
}

function wireList() {
  $("#rows").addEventListener("click", (e) => {
    const id = e.target.closest(".row")?.dataset.id;
    if (id) setTarget(id, { reveal: true });
  });
  $("#more").addEventListener("click", () => { state.showAll = true; renderList(); });
  $("#filter").addEventListener("input", (e) => { state.filter = e.target.value; renderList(); });
  document.querySelectorAll(".sort button").forEach((b) => b.addEventListener("click", () => {
    state.sort = b.dataset.sort;
    document.querySelectorAll(".sort button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderList();
  }));
}

/* ---------- URL state ---------- */

function saveUrl() {
  try {
    const p = new URLSearchParams();
    if (state.base) p.set("from", state.base.id);
    p.set("amount", String(state.amount));
    if (state.target) p.set("to", state.target.id);
    history.replaceState(null, "", `${location.pathname}?${p}`);
  } catch { /* sandboxed frames may refuse; the page works without it */ }
}

function initialSelection() {
  let p;
  try { p = new URLSearchParams(location.search); } catch { p = new URLSearchParams(); }
  const amount = parseAmount(p.get("amount") || "");
  if (amount) state.amount = amount;
  let base = p.get("from")?.toUpperCase();
  if (!state.countries.has(base)) {
    const region = (navigator.language || "").split("-")[1]?.toUpperCase();
    const f = region && state.world.features.find((x) => x.a2 === region);
    base = f && state.countries.has(f.id) ? f.id : "USA";
  }
  const to = p.get("to")?.toUpperCase();
  return { base, target: state.countries.has(to) && to !== base ? to : base === "USA" ? "GBR" : "USA" };
}

/* ---------- render & boot ---------- */

function render() {
  if (!state.base) return;
  paintMap();
  renderLegend();
  renderResult();
  renderList();
  renderSources();
  saveUrl();
}

async function boot() {
  try {
    const [world, data] = await Promise.all([getJson("world.json"), loadData()]);
    state.world = world;
    state.meta = data;
    state.rates = { ...data.fx.rates };
    const names = new Map(world.features.map((f) => [f.id, f.name]));
    for (const c of data.countries) state.countries.set(c.id, { ...c, name: names.get(c.id) || c.name });
    buildMap();
    applyView();
    const { base, target } = initialSelection();
    $("#amount").value = plain.format(state.amount);
    sizeInput($("#amount"), $("#amount").value);
    wireAmount();
    wireCombobox();
    wireList();
    state.target = state.countries.get(target) || null;
    setBase(base);
    setStatus("");
    // Re-measure the inline inputs once the display font has arrived.
    document.fonts?.ready.then(() => {
      sizeInput($("#amount"), $("#amount").value);
      sizeInput($("#base"), $("#base").value);
    });
    refreshFx();
  } catch (e) {
    console.error(e);
    setStatus("Couldn't load prices and exchange rates. The World Bank, IMF or currency API didn't respond. Reload the page to try again.");
  }
}

boot();
