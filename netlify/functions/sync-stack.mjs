// netlify/functions/sync-stack.mjs
// ---------------------------------------------------------------------------
// One-click bridge: lets a link/button in Notion (or anywhere) trigger the
// "Sync The Stack" GitHub Action without leaving the page. It fires the
// workflow via workflow_dispatch, then shows a branded confirmation.
//
// Netlify environment variables (Site settings -> Environment variables):
//   GH_DISPATCH_TOKEN  (required)  Fine-grained GitHub PAT scoped to the
//                                  hicksnewmedia/hicksnewmedia.com repo with
//                                  permission: Actions = Read and write.
//   SYNC_KEY           (optional)  If set, the request must include
//                                  ?key=<SYNC_KEY> or it is rejected. Leave
//                                  unset for an open (still harmless) endpoint.
//
// Button / link target:
//   https://hicksnewmedia.com/.netlify/functions/sync-stack
//   (append ?key=YOUR_KEY only if you set SYNC_KEY)
// ---------------------------------------------------------------------------

const OWNER = 'hicksnewmedia';
const REPO = 'hicksnewmedia.com';
const WORKFLOW = 'sync-stack.yml';
const REF = 'main';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function page(eyebrow, title, message, accent) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Stack — Sync</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=National+Park:wght@600;800&family=Geist:wght@400;500&family=Red+Hat+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  :root{--paper:#F5F1EB;--ink:#0A0A0A;--ink-3:#57534E;--signal:${accent};}
  *{box-sizing:border-box} html,body{height:100%}
  body{margin:0;display:flex;align-items:center;justify-content:center;
    background:var(--paper);color:var(--ink);font-family:'Geist',system-ui,sans-serif;padding:24px}
  .card{max-width:520px;text-align:center}
  .eyebrow{font-family:'Red Hat Mono',monospace;font-size:12px;letter-spacing:3px;
    text-transform:uppercase;color:var(--signal);margin-bottom:18px}
  h1{font-family:'National Park',sans-serif;font-weight:800;font-size:38px;
    letter-spacing:-1px;margin:0 0 14px;line-height:1.05}
  p{font-size:16px;line-height:1.55;color:var(--ink-3);margin:0 auto;max-width:420px}
  .dot{display:inline-block;width:12px;height:12px;border-radius:999px;background:var(--signal);margin-bottom:24px}
  .foot{font-family:'Red Hat Mono',monospace;font-size:11px;letter-spacing:1.5px;
    text-transform:uppercase;color:var(--ink-3);margin-top:32px}
</style></head>
<body><div class="card">
  <div class="dot"></div>
  <div class="eyebrow">${escapeHtml(eyebrow)}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <div class="foot">HicksNewMedia · No Hype. Just the Facts.</div>
</div></body></html>`;
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body
  };
}

export const handler = async (event) => {
  const token = process.env.GH_DISPATCH_TOKEN;
  const key = process.env.SYNC_KEY;
  const provided = (event.queryStringParameters && event.queryStringParameters.key) || '';

  if (key && provided !== key) {
    return reply(401, page('Sync · 401', 'Not authorized', 'This sync link is missing or has the wrong key.', '#D96A14'));
  }
  if (!token) {
    return reply(500, page('Sync · 500', 'Not configured', 'GH_DISPATCH_TOKEN is not set in Netlify environment variables.', '#D96A14'));
  }

  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'hnm-stack-sync'
      },
      body: JSON.stringify({ ref: REF })
    }
  );

  if (res.status === 204) {
    return reply(200, page(
      'Sync · triggered',
      'The Stack is rebuilding.',
      'It is regenerating from your Notion registry now. Give it about a minute, then refresh links.hicksnewmedia.com. You can close this tab.',
      '#F48022'
    ));
  }

  const detail = (await res.text()).slice(0, 280);
  return reply(502, page(
    'Sync · failed',
    'GitHub did not accept it.',
    `Status ${res.status}. ${detail}`,
    '#D96A14'
  ));
};
