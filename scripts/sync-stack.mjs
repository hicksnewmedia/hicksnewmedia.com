// scripts/sync-stack.mjs
// Reads the Notion "The Stack — Tool Registry" and regenerates links/tools.json.
// No npm dependencies — uses Node 20+ built-in fetch.
//
// Env:
//   NOTION_TOKEN  (required)  Internal integration secret. The database must be
//                             shared with this integration (Content access).
//   DATABASE_ID   (optional)  Defaults to the registry created for The Stack.
//   OUTPUT_PATH   (optional)  Defaults to links/tools.json.
//
// Publish rule: a row is published when it has a Tool name AND at least one link
// (Official Link OR Affiliate Link). The page CTA uses affiliate || official, so
// an affiliate-only row is valid. Any skipped row is reported in the run log and
// raised as a GitHub annotation — skips are never silent.

import { writeFile } from 'node:fs/promises';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID || 'f0c74b57678f4c13a9701f627e2b69c6';
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'links/tools.json';
const NOTION_VERSION = '2022-06-28';

if (!NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN environment variable.');
  process.exit(1);
}

// ---- Static shell (matches tools.json schema) -------------------------------
const CATEGORIES = [
  { key: 'hardware', label: 'Hardware' },
  { key: 'studio',   label: 'Studio & Production' },
  { key: 'ai',       label: 'AI & Automation' },
  { key: 'ops',      label: 'Knowledge & Ops' },
  { key: 'spatial',  label: 'Wearables & Spatial' },
  { key: 'audience', label: 'Publishing & Audience' }
];

const CATEGORY_KEY = {
  'Hardware': 'hardware',
  'Studio & Production': 'studio',
  'AI & Automation': 'ai',
  'Knowledge & Ops': 'ops',
  'Wearables & Spatial': 'spatial',
  'Publishing & Audience': 'audience'
};

const DEFAULT_CATEGORY = 'ops';

const DISCLOSURE = 'Some links are affiliate links. I only list tools I actually use — No Hype. Just the Facts.';
const STATS = { yearsInTech: '30+' };

// ---- Notion property helpers ------------------------------------------------
const title = (p) => (p?.title || []).map((t) => t.plain_text).join('').trim();
const text = (p) => (p?.rich_text || []).map((t) => t.plain_text).join('').trim();
const url = (p) => (p?.url || '').trim();
const bool = (p) => !!p?.checkbox;
const select = (p) => p?.select?.name || '';
const num = (p) => (typeof p?.number === 'number' ? p.number : 9999);

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// GitHub Actions annotation — surfaces in the run summary, not just the log.
function annotate(message) {
  console.log(`::warning title=Stack sync::${message}`);
}

// ---- Query the database (paginated) -----------------------------------------
async function queryDatabase() {
  const rows = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        page_size: 100,
        start_cursor: cursor,
        filter: { property: 'Live', checkbox: { equals: true } }
      })
    });
    if (!res.ok) {
      throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return rows;
}

// ---- Map a Notion page to a tool --------------------------------------------
function toTool(page) {
  const p = page.properties;
  const name = title(p['Tool']);
  const rawCategory = select(p['Category']);
  const category = CATEGORY_KEY[rawCategory] || DEFAULT_CATEGORY;
  const icon = text(p['Logo Icon']);
  const letters = text(p['Logo Text']);
  const logo = icon ? { icon } : { text: letters || name.slice(0, 2).toUpperCase() };

  return {
    _order: num(p['Order']),
    _rawCategory: rawCategory,
    id: slug(name),
    name,
    category,
    featured: bool(p['Featured']),
    topPick: bool(p['Top Pick']),
    tagline: text(p['Tagline']),
    description: text(p['Description']),
    logo,
    url: url(p['Official Link']),
    affiliateUrl: url(p['Affiliate Link']),
    ctaLabel: text(p['CTA Label']) || 'Visit'
  };
}

// ---- Validity: returns null if publishable, else a human reason -------------
function skipReason(t) {
  if (!t.name) return 'no Tool name';
  if (!t.url && !t.affiliateUrl) return 'no Official Link or Affiliate Link';
  return null;
}

// ---- Build + write ----------------------------------------------------------
async function main() {
  const rows = await queryDatabase();
  const mapped = rows.map(toTool);

  const kept = [];
  const skipped = [];
  for (const t of mapped) {
    const reason = skipReason(t);
    if (reason) {
      skipped.push({ name: t.name || '(untitled row)', reason });
      continue;
    }
    // Published, but flag a Category typo so it doesn't quietly land in Ops.
    if (t._rawCategory && !CATEGORY_KEY[t._rawCategory]) {
      annotate(`"${t.name}" has an unrecognized Category "${t._rawCategory}" — placed in Knowledge & Ops. Fix the Category to recategorize.`);
      console.log(`  ~ ${t.name} — Category "${t._rawCategory}" not recognized; defaulted to Knowledge & Ops.`);
    }
    kept.push(t);
  }

  const tools = kept
    .sort((a, b) => a._order - b._order)
    .map(({ _order, _rawCategory, ...rest }) => rest);

  const payload = {
    schemaVersion: 1,
    source: 'Notion · The Stack — Tool Registry',
    updated: new Date().toISOString().slice(0, 10),
    stats: STATS,
    disclosure: DISCLOSURE,
    categories: CATEGORIES,
    tools
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  // ---- Run report -----------------------------------------------------------
  console.log(`Queried ${rows.length} live row(s) → published ${tools.length}, skipped ${skipped.length}.`);
  if (skipped.length) {
    console.log(`Skipped row(s) — not published:`);
    for (const s of skipped) {
      console.log(`  • ${s.name} — ${s.reason}`);
      annotate(`"${s.name}" was not published — ${s.reason}.`);
    }
  }
  console.log(`Wrote ${tools.length} tool(s) to ${OUTPUT_PATH}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
