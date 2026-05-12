# hicksnewmedia.com

The production website for HicksNewMedia, an independent media agency.
Built on the locked Round 05 brand system (National Park slab + Red Hat
Mono, HNM. monogram + HicksNewMedia. wordmark). Hosted on **Netlify**.
Dynamic content lives in **Supabase**.

The "From the Channel" section auto-syncs with @JamesHicks on YouTube daily.

---

## Architecture at a glance

```
                   ┌─────────────────────────────────────────┐
                   │  YouTube Data API                       │
                   │  (latest videos from @JamesHicks)       │
                   └─────────────────┬───────────────────────┘
                                     │  1× per day
                                     ▼
        ┌────────────────────────────────────────────────────┐
        │  Supabase                                          │
        │  • pg_cron schedules HTTP call (daily 4am PT)      │
        │  • Edge Function: update-videos (Deno/TS)          │
        │    fetches YouTube API, writes to table            │
        │  • latest_videos table (source of truth)           │
        └────────────────────────────────────────────────────┘
                                     ▲
                                     │  every page load
                                     │  (REST API via anon key)
                                     │
        ┌────────────────────────────────────────────────────┐
        │  Netlify (one site, three subdomains)              │
        │  • hicksnewmedia.com         → /index.html         │
        │  • mediakit.hicksnewmedia.com → /mediakit/         │
        │  • links.hicksnewmedia.com    → /links/            │
        │  • shared /assets/ for logos, favicons, PDF        │
        │  • deploys on git push                             │
        │  • client-side JS on main site pulls latest        │
        │    videos from Supabase and renders the cards      │
        └────────────────────────────────────────────────────┘
                                     ▲
                                     │
                ┌────────────────────┼────────────────────┐
                │                    │                    │
        hicksnewmedia.com   mediakit.hicksnewmedia   links.hicksnewmedia
                                    .com                 .com
```

The static HTML is the fallback. Even if Supabase is unreachable, JS is
blocked, or fetch fails, visitors see the last-known set of video cards
baked into the HTML — slightly stale but never broken.

---

## What's in this repo

```
hicksnewmedia.com/
├── index.html                      ← main site (~250KB) + Supabase fetch script
├── netlify.toml                    ← build config, subdomain routing, headers
├── assets/                         ← logos, favicons, PDF (shared across subdomains)
│   ├── hnm-favicon-32.png
│   ├── hnm-favicon-512.png
│   ├── hnm-mark-dark.png
│   ├── hnm-mark-transparent.png
│   ├── hicksnewmedia-wordmark-dark.png
│   ├── hicksnewmedia-wordmark-transparent.png
│   ├── hnm-lockup-dark.png
│   └── james-hicks-media-kit.pdf   ← downloadable PDF media kit
├── mediakit/
│   └── index.html                  ← served on mediakit.hicksnewmedia.com
├── links/
│   └── index.html                  ← served on links.hicksnewmedia.com
└── supabase/
    ├── config.toml                                   ← function config
    ├── migrations/
    │   ├── 20260511000001_create_latest_videos.sql   ← table + RLS
    │   └── 20260511000002_schedule_update_videos.sql ← pg_cron schedule
    └── functions/
        └── update-videos/
            └── index.ts                              ← Edge Function code
```

**Three subdomains, one repo, one Netlify site.** The `netlify.toml`
routes each subdomain to the right `index.html` via host-based rewrites.
The `assets/` folder is shared — `/assets/hnm-mark-dark.png` works from
all three subdomains automatically.

---

## Migration Playbook — Manus → Netlify + Supabase

Total clicking time the first time: ~75 minutes (60 min for the main
site + Supabase, 15 min for the two subdomains). After this, the only
thing you ever need to do is publish videos on YouTube and (optionally)
edit `index.html`, `mediakit/index.html`, or `links/index.html` when
you want to change site content.

### Phase 0 — Gather what you need

1. **Your YouTube channel ID.** The `UC...` string, not `@JamesHicks`.
   Get it at <https://www.youtube.com/account_advanced>.
2. **DNS access for hicksnewmedia.com.** Wherever you registered it.
3. **A YouTube Data API key.** See Phase 4 below — free, 5-minute setup.
4. **A random secret string** for cron auth. Any 32+ character random
   string. You can generate one with: `openssl rand -hex 32`
   (or any password generator).

### Phase 1 — Export from Manus (backup only)

You already have Netlify and Supabase accounts, so skip the long path.
Just grab a backup:

1. Open the Manus workspace.
2. **View all files in this task** → **Batch Download**.
3. Save the zip somewhere safe. You won't use these files; they're
   purely a backup. The clean `index.html` in this package replaces
   everything Manus built.

### Phase 2 — Push to GitHub

You're using GitHub for `dc-resource-library` already, so add this repo
to the same org.

1. <https://github.com/new>.
2. Owner: `hicksnewmedia` (or your account). Name: `hicksnewmedia.com`.
   Visibility: Private (or public — either works). Don't initialize with
   anything.
3. Locally, from the folder where you unzipped this package:

```bash
git init
git add .
git commit -m "Initial commit: HicksNewMedia.com on Netlify + Supabase"
git branch -M main
git remote add origin https://github.com/hicksnewmedia/hicksnewmedia.com.git
git push -u origin main
```

### Phase 3 — Set up Supabase

#### 3a. Create the project (skip if you already have one for this site)

1. <https://supabase.com/dashboard>.
2. **New Project**. Pick your org, name it `hicksnewmedia`, give it a
   strong DB password (save it somewhere — you usually won't need it,
   but Supabase requires one).
3. Region: pick the one closest to your audience (US West if you're
   serving primarily US, otherwise pick by audience geography).
4. Wait ~2 minutes for the project to provision.

#### 3b. Get the project credentials

In the Supabase dashboard, **Settings → API**:

| Field           | What it is                                                       |
|-----------------|------------------------------------------------------------------|
| Project URL     | `https://YOUR_PROJECT_REF.supabase.co` — copy this               |
| anon public     | Public key, safe in client code — copy this                      |
| service_role    | Server key, never expose — only used by the Edge Function        |

Also grab the **Project ref** from **Settings → General** — it's the
subdomain of your project URL.

#### 3c. Create the latest_videos table

1. In the dashboard, **SQL Editor** → **New Query**.
2. Paste the entire contents of `supabase/migrations/20260511000001_create_latest_videos.sql`.
3. **Run**. You should see "Success. No rows returned."
4. Verify: **Table Editor** → you should see `latest_videos` in the list, empty.

### Phase 4 — Get a YouTube API key

1. <https://console.cloud.google.com/>.
2. Create a project: `hicksnewmedia-website` (or anything).
3. **APIs & Services → Library** → search "YouTube Data API v3" → **Enable**.
4. **APIs & Services → Credentials → + CREATE CREDENTIALS → API key**.
5. Copy the generated key. Click **Restrict key** → API restrictions →
   pick only "YouTube Data API v3" → Save.

Free tier is 10,000 quota units/day. This script uses ~3 units/run.
You could run it 3,000× a day and still be free.

### Phase 5 — Deploy the Edge Function

#### Option A — Via Supabase CLI (recommended)

Install the CLI if you don't have it:

```bash
brew install supabase/tap/supabase
# Or: npm install -g supabase
```

From the repo root:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy update-videos --no-verify-jwt
```

#### Option B — Via the dashboard (no CLI)

1. **Edge Functions → Create a new function** → name it `update-videos`.
2. Toggle off "Verify JWT with legacy secret".
3. Paste the contents of `supabase/functions/update-videos/index.ts`
   into the editor.
4. **Deploy**.

#### 5a. Set the function's secrets

Either way you deployed, now set the three secrets:

1. **Edge Functions → update-videos → Secrets** (or via CLI:
   `supabase secrets set ...`).
2. Add these three:

   | Name                  | Value                                       |
   |-----------------------|---------------------------------------------|
   | `YOUTUBE_CHANNEL_ID`  | Your `UC...` channel ID                     |
   | `YOUTUBE_API_KEY`     | The Google API key from Phase 4             |
   | `CRON_SECRET`         | Your random 32+ char secret from Phase 0    |

   (You don't need to set `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` —
   Supabase auto-provides those to all Edge Functions.)

#### 5b. Test the function manually

In the dashboard, **Edge Functions → update-videos → Logs** open in one
tab. In another tab, in your terminal:

```bash
curl -i -X POST \
  https://YOUR_PROJECT_REF.supabase.co/functions/v1/update-videos \
  -H 'x-cron-secret: YOUR_CRON_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

You should see a 200 response with a JSON body listing 6 videos. In the
Table Editor, the `latest_videos` table now has 6 rows.

If you get a 401, the `CRON_SECRET` value doesn't match.
If you get a 500, check the function logs — likely a missing YouTube
secret or a bad channel ID.

### Phase 6 — Schedule the daily run

1. Open `supabase/migrations/20260511000002_schedule_update_videos.sql`
   in any editor.
2. Replace `YOUR_PROJECT_REF` with your real project ref.
3. Replace `YOUR_CRON_SECRET` with the same secret you set in Phase 5a.
4. In the Supabase dashboard, **SQL Editor → New Query**, paste the
   edited SQL, **Run**.
5. Verify the schedule with:
   ```sql
   select * from cron.job where jobname = 'hnm-update-latest-videos';
   ```
   You should see one row showing the schedule `0 11 * * *`.

The function will now fire daily at 11:00 UTC (4am PT) without you doing
anything.

### Phase 7 — Wire the site to Supabase

1. Open `index.html` in any editor.
2. Find the block near the bottom that says `window.HNM_CONFIG`.
3. Replace the two placeholder values:

```html
<script>
  window.HNM_CONFIG = {
    SUPABASE_URL:      "https://YOUR_PROJECT_REF.supabase.co",  ← your real project URL
    SUPABASE_ANON_KEY: "YOUR_PUBLIC_ANON_KEY"                   ← your real anon key
  };
</script>
```

Both values are safe in client-side code. RLS policies on the
`latest_videos` table allow only SELECT for the anon key — no one can
write to your table from the browser.

4. Commit and push:
   ```bash
   git add index.html
   git commit -m "Wire site to Supabase backend"
   git push
   ```

### Phase 8 — Deploy to Netlify

1. <https://app.netlify.com/> → **Add new site → Import an existing project**.
2. Connect to GitHub → select the `hicksnewmedia.com` repo.
3. Build settings (Netlify will read these from `netlify.toml` but verify):
   - **Build command:** (empty)
   - **Publish directory:** `.`
   - **Branch to deploy:** `main`
4. **Deploy site**.

In ~30 seconds you get a temporary `your-site-name.netlify.app` URL.
Click it. The site should load with the new HicksNewMedia. wordmark in
the nav and the video cards should briefly show your static fallback,
then update with the live data from Supabase within a second.

If the cards don't update: open browser DevTools → Console. You'll see
either a clear error message (most likely a config issue) or a network
failure to investigate.

### Phase 9 — DNS pre-flight (READ BEFORE TOUCHING ANYTHING)

You are keeping your existing DNS provider (Path B) because you have
custom email configured at `@hicksnewmedia.com`. This means you'll
manually swap a few records and **leave everything else alone**.

#### 9a. DO NOT TOUCH these record types

These are unrelated to the website migration. Modifying them will break
email, domain ownership verification, or other services:

- **MX records** — route incoming email
- **TXT records for SPF** (start with `v=spf1`)
- **TXT records for DKIM** (usually at hostnames like `default._domainkey`)
- **TXT records for DMARC** (at `_dmarc`)
- **TXT records for domain verification** — e.g. `google-site-verification=...`,
  `MS=...`, `apple-domain-verification=...`
- **Other subdomain records** — `booking.hicksnewmedia.com`,
  `merch.hicksnewmedia.com`, anything else not in the list of four below

You are ONLY changing four records: apex, `www`, `mediakit`, `links`.

#### 9b. Take a backup screenshot of your current DNS

Log into your DNS provider. Capture a screenshot (or copy/paste into a
text file) of every record currently shown. This is your rollback
insurance — if anything misbehaves during cutover, you can restore the
exact original config.

#### 9c. (Optional) Lower TTL 24 hours ahead for faster cutover

If you can plan the cutover a day in advance: today, set the TTL on the
four records you'll be changing (apex A/CNAME, `www`, `mediakit`, `links`)
to `300` (5 minutes) without changing the values. Tomorrow when you flip
them, the change propagates in 5 minutes instead of an hour.

This is optional. If you skip it, expect 30-60 minutes of propagation
instead of 5.

### Phase 10 — Add the new records and cut over

The order below is designed so visitors see *some* working version of
each subdomain at every moment — never a dead DNS error.

#### 10a. Add the four hostnames as Netlify Domain Aliases

In the Netlify dashboard, **Domain settings → Add domain alias** four times:

- `hicksnewmedia.com`
- `www.hicksnewmedia.com`
- `mediakit.hicksnewmedia.com`
- `links.hicksnewmedia.com`

This pre-arms Netlify to answer for those hostnames. Until you do this,
Netlify rejects requests for them even if DNS resolves correctly. SSL
certs auto-provision via Let's Encrypt once DNS resolves.

Netlify will show you exactly which DNS records to add, including:
- The apex IP address to use (currently `75.2.60.5` — but use whatever
  Netlify displays in case they've updated it)
- Your Netlify site's hostname for CNAMEs (typically
  `your-site-name.netlify.app`)

#### 10b. Add the four new records at your DNS provider

Log into your registrar's DNS dashboard. Add these four records.
**Don't delete anything yet** — you're adding in parallel to the old
Manus records.

| Type  | Name      | Value                              | TTL  |
|-------|-----------|------------------------------------|------|
| A     | `@`       | `75.2.60.5` (apex IP from Netlify) | 300  |
| CNAME | `www`     | `your-site-name.netlify.app`       | 300  |
| CNAME | `mediakit`| `your-site-name.netlify.app`       | 300  |
| CNAME | `links`   | `your-site-name.netlify.app`       | 300  |

The `@` symbol means the apex (the bare domain with nothing in front).
Some registrars use a blank field instead — same thing.

**Note on the apex:** DNS standards don't allow a CNAME at the apex,
which is why apex uses an A record while subdomains use CNAMEs. If your
DNS provider supports `ALIAS` or `ANAME` (Cloudflare, DNSimple, some
others), you can use that instead of an A record — it's cleaner because
Netlify can update the underlying IP without you needing to. Otherwise
A record is fine.

You may temporarily have *both* the old Manus records and the new
Netlify records present. That's normal during cutover. DNS will only
return one at a time based on which record actually exists; once you
add the new ones, your provider returns the new ones (since you'll
delete the old ones in the next step).

If your DNS provider doesn't allow duplicate records of the same
type at the same name (some don't), you'll have to edit the existing
record in place rather than add and then delete. Same result, slightly
different mechanics.

#### 10c. Wait for propagation

Open <https://dnschecker.org/> and check each of the four hostnames.
Once you see the new values resolving from multiple geographic
locations, you're good to proceed. Typical wait: 5-15 minutes if you
pre-lowered TTL, up to an hour otherwise.

#### 10d. Verify everything works

Open each subdomain in a browser:

- `hicksnewmedia.com` → main site (with the live video cards from Supabase)
- `www.hicksnewmedia.com` → same main site
- `mediakit.hicksnewmedia.com` → media kit page with PDF download
- `links.hicksnewmedia.com` → link hub

Send yourself a test email to and from `@hicksnewmedia.com` to confirm
email is unaffected. (It should be — you didn't touch MX/SPF/DKIM/DMARC.)

If a subdomain shows the wrong page or 404s, most common causes:
- DNS still propagating — give it more time
- Domain alias not added in Netlify dashboard yet
- Typo in the CNAME value (must match Netlify's hostname exactly)

#### 10e. Delete the old Manus records

Now that the new records are serving traffic and verified working,
delete the four old Manus records at your registrar. This is cleanup,
not load-bearing — the new records are already handling traffic.

#### 10f. (Optional) Raise TTL back to 3600

If you lowered TTL in Phase 9c, raise it back to `3600` (1 hour) or
higher on the four records you just added. This improves caching
efficiency now that the cutover is stable.

#### 10g. How the routing works (for context)

When DNS resolves and someone hits `mediakit.hicksnewmedia.com`:

1. Request reaches Netlify with `Host: mediakit.hicksnewmedia.com`
2. The redirect rule in `netlify.toml` matches the root path `/` for
   that host and rewrites internally to `/mediakit/index.html`
3. Netlify serves `mediakit/index.html` — the URL bar still shows
   `mediakit.hicksnewmedia.com`
4. The page's CSS, fonts, favicons, logos, and the PDF download all
   reference `/assets/...` — Netlify serves those from the same site
   root, so they work seamlessly across all three subdomains

Same flow for `links.hicksnewmedia.com` → `/links/index.html`.

### Phase 11 — Decommission Manus (optional)

Three subdomains now point to Netlify, so the Manus-hosted versions are
effectively offline to the public. You can:

- Leave the Manus project as a backup
- Delete it to clean up the workspace

Either is fine.

---

## How it works going forward

### Publishing a new YouTube video

Just publish on YouTube. Within 24 hours (next 4am PT), the Edge Function
picks it up. Want it instantly? Run the curl command from Phase 5b again,
or hit the function from the Supabase dashboard with the test button.

### Editing site content (copy, layout, sections)

Edit `index.html` locally, commit, push. Netlify redeploys within ~30
seconds.

You can also edit directly through GitHub's web UI: click the file in
the repo, click the pencil, edit, commit. Same result.

### Adding a new image or asset

Drop it in `assets/`, commit, push. Live at `hicksnewmedia.com/assets/`
within 30 seconds.

### Adding more dynamic features later

This is the real upside of Path 3. The infrastructure is in place to
add:

- **Partnership inquiry form** — create a Supabase table, add a form to
  the site, write a small POST endpoint (Edge Function or use Supabase's
  built-in REST API with INSERT policy).
- **Newsletter signups** — same pattern.
- **Dynamic case studies** — store them in Supabase, render with the
  same client-side fetch approach.
- **Member-only content** — Supabase auth + RLS policies.

Every new feature plugs into the architecture you already set up.

---

## Cost (recurring)

| Service       | Tier        | What you get                                      |
|---------------|-------------|---------------------------------------------------|
| Netlify       | Starter     | 100GB bandwidth/mo, 300 build min/mo — free       |
| Supabase      | Free        | 500MB DB, 5GB bandwidth, 500K Edge Fn invocations |
| YouTube API   | Free        | 10,000 quota units/day — script uses ~3/day       |
| GitHub        | Free        | Unlimited public + private repos                  |

**Total recurring cost: $0/month** unless you outgrow Netlify or Supabase
free tiers, which is very unlikely for a personal/agency site.

---

## Troubleshooting

**Cards don't update on the site — only show the static fallback**

Open browser DevTools → Console. Common causes:
- `HNM_CONFIG` placeholders not replaced in `index.html`
- Wrong Supabase URL or anon key
- RLS policy blocking the read (verify the SELECT policy exists on
  `latest_videos`)
- CORS issue — Supabase handles CORS for the REST API automatically, but
  custom configs can break it

**Edge Function returns 401**

The `x-cron-secret` header doesn't match the `CRON_SECRET` env var.
Either re-set the secret in the Edge Function settings or update the
SQL schedule to use the right secret.

**Edge Function returns 500: "Channel not found"**

`YOUTUBE_CHANNEL_ID` is wrong. Should be the `UC...` string, not the
`@handle`.

**Edge Function returns 500: "API key not valid"**

Either the key is wrong, or the YouTube Data API v3 isn't enabled for
that key's project. Re-check in Google Cloud Console.

**The schedule fires but nothing changes in the table**

Check the function logs. Most likely the function itself is failing
silently from inside cron. You can manually trigger it via curl (Phase
5b) to see the response.

**Netlify deploy fails**

Check the build log in the Netlify dashboard. Most common cause: a
syntax error in `netlify.toml` or `index.html` from a manual edit.

**DNS resolves to old Manus host after several hours**

The old records weren't fully removed at your registrar, or your TTL is
very long. Re-check the registrar; verify only Netlify's records exist.

---

## Brand reference

Locked Round 05 brand system documented at:
<https://www.notion.so/35d66f35c80f816c92d9ebdbb0fcd6e5>

---

*HicksNewMedia. An independent media agency. Est. 2010.*
*No Hype. Just the Facts.*
