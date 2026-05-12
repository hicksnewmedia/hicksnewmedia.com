// ═══════════════════════════════════════════════════════════════════
// update-videos — Supabase Edge Function
// ═══════════════════════════════════════════════════════════════════
// Fetches the latest videos from @JamesHicks on YouTube and writes
// them to the latest_videos table in Supabase. Triggered daily by the
// pg_cron schedule (see supabase/migrations/*_schedule_update_videos.sql).
//
// Required environment secrets (set via Supabase dashboard → Edge Functions
// → update-videos → Secrets):
//   YOUTUBE_CHANNEL_ID    — your YouTube channel ID (UC...)
//   YOUTUBE_API_KEY       — Google Cloud API key with YouTube Data v3 enabled
//   CRON_SECRET           — random string, must match the one in the cron SQL
//
// Auto-provided by Supabase (no need to set):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const NUM_VIDEOS = 6;

interface VideoRow {
  id: string;
  title: string;
  published_at: string;
  duration_seconds: number;
  thumbnail_url: string;
  category_label: string;
}

// ─── YouTube API helpers ─────────────────────────────────────────────
async function ytFetch(endpoint: string, params: Record<string, string>, apiKey: string) {
  const qs = new URLSearchParams({ ...params, key: apiKey });
  const url = `${YT_API_BASE}/${endpoint}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${endpoint} failed: ${res.status} — ${body}`);
  }
  return await res.json();
}

async function getUploadsPlaylistId(channelId: string, apiKey: string): Promise<string> {
  const data = await ytFetch('channels', { part: 'contentDetails', id: channelId }, apiKey);
  if (!data.items?.length) {
    throw new Error(`Channel not found: ${channelId}`);
  }
  return data.items[0].contentDetails.relatedPlaylists.uploads;
}

async function getLatestPlaylistItems(playlistId: string, n: number, apiKey: string) {
  const data = await ytFetch(
    'playlistItems',
    { part: 'snippet', playlistId, maxResults: String(n) },
    apiKey,
  );
  return data.items ?? [];
}

async function getVideoDurations(videoIds: string[], apiKey: string): Promise<Record<string, number>> {
  if (!videoIds.length) return {};
  const data = await ytFetch(
    'videos',
    { part: 'contentDetails', id: videoIds.join(',') },
    apiKey,
  );
  const out: Record<string, number> = {};
  for (const item of data.items ?? []) {
    out[item.id] = parseDuration(item.contentDetails.duration);
  }
  return out;
}

// ─── Pure helpers ────────────────────────────────────────────────────
function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || '0') * 3600) +
         (parseInt(m[2] || '0') * 60) +
         parseInt(m[3] || '0');
}

function durationLabel(seconds: number): string {
  if (seconds < 60)      return 'Short';
  if (seconds < 5 * 60)  return 'Quick Take';
  if (seconds < 20 * 60) return 'Brief';
  return 'Long-form';
}

function bestThumbUrl(thumbs: Record<string, { url: string }>, videoId: string): string {
  for (const key of ['maxres', 'standard', 'high', 'medium', 'default']) {
    if (thumbs?.[key]?.url) return thumbs[key].url;
  }
  // Always-available fallback
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// ─── Handler ─────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Simple auth: require the cron secret header. This prevents the
  // function from being invokable by anyone with the URL.
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret) {
    return new Response(JSON.stringify({ error: 'CRON_SECRET not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (req.headers.get('x-cron-secret') !== cronSecret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const channelId = Deno.env.get('YOUTUBE_CHANNEL_ID');
    const apiKey = Deno.env.get('YOUTUBE_API_KEY');
    if (!channelId || !apiKey) {
      throw new Error('YOUTUBE_CHANNEL_ID or YOUTUBE_API_KEY not configured');
    }

    console.log(`Fetching uploads playlist for channel ${channelId}`);
    const uploadsId = await getUploadsPlaylistId(channelId, apiKey);

    console.log(`Fetching latest ${NUM_VIDEOS} videos`);
    const items = await getLatestPlaylistItems(uploadsId, NUM_VIDEOS, apiKey);
    if (!items.length) throw new Error('No videos returned from playlist');

    const videoIds = items.map((i: any) => i.snippet.resourceId.videoId);
    const durations = await getVideoDurations(videoIds, apiKey);

    const videos: VideoRow[] = items.map((item: any) => {
      const sn = item.snippet;
      const vid = sn.resourceId.videoId;
      const dur = durations[vid] ?? 0;
      return {
        id: vid,
        title: sn.title,
        published_at: sn.publishedAt,
        duration_seconds: dur,
        thumbnail_url: bestThumbUrl(sn.thumbnails ?? {}, vid),
        category_label: durationLabel(dur),
      };
    });

    // Write to Supabase using the service role key (bypasses RLS)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Replace the table contents: delete everything, then insert the
    // current top 6. Done as two operations because Supabase JS client
    // doesn't expose transactions, but this is fine — the worst case
    // is a brief window of empty cards if the page is hit between
    // delete and insert, which the static fallback handles.
    const { error: delErr } = await supabase
      .from('latest_videos')
      .delete()
      .neq('id', '___never_matches___');
    if (delErr) throw new Error(`Delete failed: ${delErr.message}`);

    const { error: insErr } = await supabase
      .from('latest_videos')
      .insert(videos);
    if (insErr) throw new Error(`Insert failed: ${insErr.message}`);

    console.log(`✓ Wrote ${videos.length} videos to latest_videos`);

    return new Response(
      JSON.stringify({ updated: videos.length, videos }, null, 2),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('update-videos failed:', message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
