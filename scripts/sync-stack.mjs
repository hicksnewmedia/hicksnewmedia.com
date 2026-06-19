// scripts/sync-stack.mjs
// Reads the Notion "The Stack — Tool Registry" and regenerates links/tools.json.
// No npm dependencies — uses Node 20+ built-in fetch.
//
// Env:
//   NOTION_TOKEN  (required)  Internal integration secret. The database must be
//                             shared with this integration (Content access).
//   DATABASE_ID   (optional)  Defaults to the registry created for The Stack.
//   OUTPUT_PATH   (optional)  Defaults to links/tools.json.

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
  const category = CATEGORY_KEY[select(p['Category'])] || 'ops';
  const icon = text(p['Logo Icon']);
  const letters = text(p['Logo Text']);
  const logo = icon ? { icon } : { text: letters || name.slice(0, 2).toUpperCase() };

  return {
    _order: num(p['Order']),
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

// ---- Build + write ----------------------------------------------------------
async function main() {
  const rows = await queryDatabase();
  const tools = rows
    .map(toTool)
    .filter((t) => t.name && t.url) // never publish a tool with no name or no link
    .sort((a, b) => a._order - b._order)
    .map(({ _order, ...rest }) => rest);

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
  console.log(`Wrote ${tools.length} tools to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
