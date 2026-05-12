-- ════════════════════════════════════════════════════════════════════
-- HicksNewMedia.com — daily schedule for update-videos Edge Function
-- ════════════════════════════════════════════════════════════════════
-- This schedules a daily HTTP call to the update-videos Edge Function
-- at 11:00 UTC (4am Pacific). The Edge Function fetches the latest
-- videos from YouTube and writes them to the latest_videos table.
--
-- BEFORE APPLYING THIS MIGRATION:
--   1. Deploy the update-videos Edge Function first (see README Phase 4)
--   2. Replace the two placeholders below with real values:
--        — YOUR_PROJECT_REF: your Supabase project ref (the subdomain
--          of your project URL, e.g. abcdefghijklmnop)
--        — YOUR_CRON_SECRET: a random string you generate yourself
--          (also set this as a secret on the Edge Function — see README)
-- ════════════════════════════════════════════════════════════════════

-- Enable the extensions we need
create extension if not exists pg_cron  with schema extensions;
create extension if not exists pg_net   with schema extensions;

-- Remove any previous schedule with this name so re-running this file
-- doesn't create duplicates
select cron.unschedule('hnm-update-latest-videos')
  where exists (select 1 from cron.job where jobname = 'hnm-update-latest-videos');

-- Schedule: daily at 11:00 UTC (4:00 am Pacific Standard Time)
-- To change the time, edit the cron expression below.
-- Format: 'minute hour day-of-month month day-of-week'
select cron.schedule(
  'hnm-update-latest-videos',
  '0 11 * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/update-videos',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'YOUR_CRON_SECRET'
    ),
    body    := '{}'::jsonb
  ) as request_id;
  $$
);

-- Verify the schedule exists. Run this anytime to inspect:
--   select * from cron.job where jobname = 'hnm-update-latest-videos';
