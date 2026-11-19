#!/usr/bin/env node
/**
 * sync-merch.mjs — builds the merch store's product index.
 *
 * Reads the Fourthwall shop (public Storefront API) and writes:
 *   merch/catalog.json  — one small file the store page loads (about 100 KB
 *                         instead of the 25 MB the raw API returns)
 *   merch/sitemap.xml   — every product URL, for search engines
 *
 * Run by .github/workflows/sync-merch.yml on a schedule. Zero dependencies,
 * Node 20+. The token below is the shop's PUBLIC storefront token (it is
 * already visible in the page source); it can only read the public catalog
 * and build carts.
 *
 * The store page still asks Fourthwall directly for a product's sizes, colors
 * and prices when a shopper opens it, so those are always live. This index
 * only decides what appears on the shelves.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.FOURTHWALL_STOREFRONT_TOKEN || "ptkn_249e4df2-8b4e-46fe-80d7-043d83da3104";
const API = "https://storefront-api.fourthwall.com/v1";
const SITE = "https://merch.hicksnewmedia.com";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "merch");

/* ───────────── Shelves by type ─────────────
   Order here is the order shoppers see. `match` runs against the product
   name; the first shelf that matches wins. Hats, Shoes and Bottoms also
   trust the Fourthwall collections of the same name. */
const TYPES = [
  { id: "tees",      label: "Tees & tops",          match: /\b(t-?shirt|tee|the t|oversized t|crop top|jersey|polo)\b/i },
  { id: "hats",      label: "Hats",                 match: /\b(hat|snapback|beanie|cap)\b/i, collection: "hats" },
  { id: "shoes",     label: "Shoes",                match: /\b(kicks|shoes?|sneakers?)\b/i, collection: "shoes" },
  { id: "drinkware", label: "Mugs & bottles",       match: /\b(mug|glass|bottle|tumbler|cup)\b/i },
  { id: "bottoms",   label: "Shorts & joggers",     match: /\b(shorts|joggers?|trunks|pants|leggings)\b/i, collection: "bottoms" },
  { id: "hoodies",   label: "Hoodies & jackets",    match: /\b(hood\w*|sweatshirt|sweater|jacket|bomber|windbreaker|fleece crop)\b/i },
  { id: "home",      label: "Home & desk",          match: /\b(notebook|journal|poster|canvas|blanket|pillow|candle|binder|calendar|deskpad|desk ?mat)\b/i },
  { id: "bags",      label: "Bags & extras",        match: /\b(tote|bag|socks|sticker|pin|keychain|gift card)\b/i },
  { id: "tees",      label: "Tees & tops",          match: /./ }, // everything left is a top
];
/* Hand corrections: slug → type id. Add a line here if something lands on
   the wrong shelf. */
const TYPE_OVERRIDES = {
  "the-villain-hooded-tee": "tees",
  "geo-tote": "bags",
};

/* ───────────── Lines (by show / by design) ─────────────
   Every public Fourthwall collection becomes a line automatically, except the
   housekeeping ones below. To add a line: make a collection in Fourthwall. */
const SKIP_COLLECTIONS = new Set([
  "all", "tops", "bottoms", "hats", "shoes", "everything-else",
  "that-new-hotness", "most-popular", "digi-scoop-canvas-kicks",
]);
const HINT_COLLECTIONS = ["hats", "shoes", "bottoms", "most-popular"];
/* Friendlier display names (Fourthwall name is used when not listed). */
const LINE_NAMES = {
  "team-no-sleep": "Team No Sleep",
  "focused": "Focused",
  "stay-active": "Stay Active",
  "digi-scoop": "Digi Scoop",
  "advocate": "Advocate",
  "teknalegist": "teknalegist",
};
/* Lines that have no Fourthwall collection: matched by product name. A name
   match is also added to a same-named collection, so nothing gets left off. */
const NAME_LINES = [
  { id: "deepen-the-bag", label: "Deepen the Bag", match: /^deepen the bag/i },
  { id: "vibe-code",      label: "vibe.code",      match: /^vibe\.code/i },
  { id: "team-no-sleep",  match: /^team no sleep/i },
  { id: "hnm-stack-mark", match: /^hnm stack mark/i },
  { id: "digi-scoop",     match: /^digi scoop/i },
  { id: "focused",        match: /^focused\b/i },
  { id: "stay-active",    match: /^stay active/i },
];
/* Lines listed first, in this order; the rest follow, biggest first. */
const LINE_ORDER = ["team-no-sleep", "hnm-stack-mark", "deepen-the-bag", "focused", "digi-scoop"];

/* ───────────── helpers ───────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, tries = 4) {
  const url = `${API}${pathname}${pathname.includes("?") ? "&" : "?"}storefront_token=${TOKEN}`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`Fourthwall request failed (${pathname}): ${lastErr?.message}`);
}

async function allProductsOf(collectionSlug) {
  const out = [];
  for (let page = 0; page < 40; page++) {
    const data = await api(`/collections/${encodeURIComponent(collectionSlug)}/products?page=${page}&size=50`);
    if (!data) return null;
    out.push(...(data.results || []));
    if (!data.paging?.hasNextPage) break;
  }
  return out;
}

const decode = (s = "") =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const clean = (s = "") =>
  decode(s).replace(/[​-‏‪-‮﻿]/g, "").replace(/\s+/g, " ").trim();
const plain = (html = "") => clean(String(html).replace(/<[^>]+>/g, " "));
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function typeOf(p, hints) {
  if (TYPE_OVERRIDES[p.slug]) return TYPE_OVERRIDES[p.slug];
  for (const t of TYPES) {
    if (t.collection && hints[t.collection]?.has(p.id)) return t.id;
  }
  const name = clean(p.name);
  for (const t of TYPES) if (t.match.test(name)) return t.id;
  return "tees";
}

function slim(p, type, lines, rank) {
  const vs = p.variants || [];
  let lo = null;
  for (const v of vs) if (!lo || v.unitPrice.value < lo.unitPrice.value) lo = v;
  const hi = vs.reduce((m, v) => Math.max(m, v.unitPrice.value), 0);
  const colors = [];
  const seenC = new Set();
  const sizes = [];
  const seenS = new Set();
  for (const v of vs) {
    const c = v.attributes?.color;
    if (c?.name && !seenC.has(c.name)) { seenC.add(c.name); colors.push([clean(c.name), c.swatch || ""]); }
    const s = v.attributes?.size?.name;
    if (s && !seenS.has(s)) { seenS.add(s); sizes.push(clean(s)); }
  }
  const inStock = vs.some((v) => v.stock?.type === "UNLIMITED" || (v.stock?.inStock ?? 0) > 0);
  const o = {
    s: p.slug,
    n: clean(p.name),
    t: type,
    p: lo ? lo.unitPrice.value : 0,
    i: p.images?.[0]?.url || vs[0]?.images?.[0]?.url || "",
    d: (p.createdAt || "").slice(0, 10),
  };
  if (hi > o.p) o.pm = hi;
  if (lo?.compareAtPrice?.value > o.p) o.was = lo.compareAtPrice.value;
  if (lines.length) o.l = lines;
  if (colors.length) o.c = colors;
  if (sizes.length) o.z = sizes;
  const text = plain(p.description);
  if (text && !/^[.\s:]*$/.test(text)) o.x = text.length > 150 ? text.slice(0, 147).trimEnd() + "…" : text;
  const im = p.images?.[0];
  if (im?.width && im.width === im.height) o.q = 1; // square photo (hats, mugs)
  if (rank != null) o.b = rank;
  if (!inStock || p.state?.type !== "AVAILABLE") o.out = 1;
  return o;
}

/* ───────────── main ───────────── */
async function main() {
  console.log("Merch sync: reading the Fourthwall shop…");
  const products = await allProductsOf("all");
  if (!products || products.length === 0) throw new Error("Fourthwall returned no products — refusing to publish an empty store.");
  const visible = products.filter((p) => p.access?.type === "PUBLIC");
  console.log(`  ${products.length} products (${visible.length} public)`);

  const colRes = await api("/collections?size=100");
  const collections = (colRes?.results || []).map((c) => ({ ...c, name: clean(c.name) }));

  // Collections used only as hints (type shelves, best-seller order)
  const hints = {};
  const rank = new Map();
  for (const slug of HINT_COLLECTIONS) {
    const items = await allProductsOf(slug);
    hints[slug] = new Set((items || []).map((p) => p.id));
    if (slug === "most-popular") (items || []).forEach((p, i) => rank.set(p.id, i + 1));
    console.log(`  hint  ${slug}: ${items ? items.length : "missing"}`);
  }

  // Lines
  const lineMeta = new Map();   // id → {id,label}
  const lineOf = new Map();     // product id → Set(line ids)
  const addTo = (pid, lid) => { if (!lineOf.has(pid)) lineOf.set(pid, new Set()); lineOf.get(pid).add(lid); };
  for (const c of collections) {
    if (SKIP_COLLECTIONS.has(c.slug)) continue;
    const items = await allProductsOf(c.slug);
    console.log(`  line  ${c.slug}: ${items ? items.length : "missing"}`);
    if (!items || items.length === 0) continue;
    lineMeta.set(c.slug, { id: c.slug, label: LINE_NAMES[c.slug] || c.name });
    for (const p of items) addTo(p.id, c.slug);
  }
  for (const nl of NAME_LINES) {
    const hits = visible.filter((p) => nl.match.test(clean(p.name)));
    if (hits.length === 0) continue;
    if (!lineMeta.has(nl.id)) {
      if (!nl.label) continue; // only extends an existing collection
      lineMeta.set(nl.id, { id: nl.id, label: nl.label });
    }
    for (const p of hits) addTo(p.id, nl.id);
  }

  const out = visible.map((p) => {
    const type = typeOf(p, hints);
    const lines = [...(lineOf.get(p.id) || [])].filter((l) => lineMeta.has(l));
    return slim(p, type, lines, rank.get(p.id));
  });

  const typeCounts = {};
  const lineCounts = {};
  for (const p of out) {
    typeCounts[p.t] = (typeCounts[p.t] || 0) + 1;
    for (const l of p.l || []) lineCounts[l] = (lineCounts[l] || 0) + 1;
  }
  const seenType = new Set();
  const types = TYPES.filter((t) => typeCounts[t.id] && !seenType.has(t.id) && seenType.add(t.id))
    .map((t) => ({ id: t.id, label: t.label, n: typeCounts[t.id] }));
  // The order shoppers see the shelves in
  const SHELF_ORDER = ["tees", "hoodies", "hats", "shoes", "bottoms", "drinkware", "home", "bags"];
  types.sort((a, b) => SHELF_ORDER.indexOf(a.id) - SHELF_ORDER.indexOf(b.id));
  const lines = [...lineMeta.values()]
    .filter((l) => lineCounts[l.id] >= 2)
    .map((l) => ({ ...l, n: lineCounts[l.id] }))
    .sort((a, b) => {
      const ia = LINE_ORDER.indexOf(a.id), ib = LINE_ORDER.indexOf(b.id);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return b.n - a.n || a.label.localeCompare(b.label);
    });
  const keep = new Set(lines.map((l) => l.id));
  for (const p of out) if (p.l) { p.l = p.l.filter((l) => keep.has(l)); if (!p.l.length) delete p.l; }

  const catalog = { v: 1, updated: new Date().toISOString(), currency: "USD", types, lines, products: out };

  await mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, "catalog.json");

  // Leave the file alone when only the timestamp would change (no noise commits)
  let same = false;
  try {
    const prev = JSON.parse(await readFile(file, "utf8"));
    same = JSON.stringify({ ...prev, updated: 0 }) === JSON.stringify({ ...catalog, updated: 0 });
  } catch { /* first run */ }
  if (same) {
    console.log("No change in the shop since the last sync — files left as they are.");
  } else {
    await writeFile(file, JSON.stringify(catalog) + "\n");
    const today = catalog.updated.slice(0, 10);
    const urls = [`  <url><loc>${SITE}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`]
      .concat(out.map((p) => `  <url><loc>${SITE}/products/${xml(p.s)}</loc><lastmod>${p.d || today}</lastmod><priority>0.7</priority></url>`));
    await writeFile(path.join(OUT_DIR, "sitemap.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
    console.log(`Wrote merch/catalog.json (${out.length} products) and merch/sitemap.xml`);
  }

  console.log("\nShelves:");
  for (const t of types) console.log(`  ${String(t.n).padStart(3)}  ${t.label}`);
  console.log("Lines:");
  for (const l of lines) console.log(`  ${String(l.n).padStart(3)}  ${l.label}`);
  if (process.env.SHOW_SHELVES) {
    for (const t of types) console.log(`\n[${t.label}]\n  ` + out.filter((p) => p.t === t.id).map((p) => p.n).join("\n  "));
  }
}

main().catch((e) => {
  // Never publish a broken or empty index: fail loudly, keep the last good file.
  console.error("Merch sync failed:", e.message);
  process.exit(1);
});
