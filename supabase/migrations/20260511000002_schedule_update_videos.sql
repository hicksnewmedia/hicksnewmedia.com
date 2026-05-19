-- ═══════════════════════════════════════════════════════════════════════
-- 20260511000002_schedule_update_videos.sql
-- ═══════════════════════════════════════════════════════════════════════
--
-- PURPOSE
-- Schedule a daily cron job that POSTs to the update-videos Edge Function
-- to refresh the latest_videos table from the YouTube API.
--
-- SECRETS
-- This migration reads its project URL and auth secret from Supabase Vault.
-- The vault entries must exist BEFORE this migration runs.
--
-- To set up vault entries on a fresh project, run the bootstrap SQL once
-- in the Supabase Dashboard SQL Editor (the file is gitignored and kept
-- out of version control on purpose). Required vault secret names:
--   • hnm_project_url   → your full https://...supabase.co URL
--   • hnm_cron_secret   → the auth secret the Edge Function checks
--
-- IDEMPOTENCY
-- Uses a named cron job ('hnm-update-videos-daily'), so re-running this
-- migration replaces the existing schedule rather than creating duplicates.
-- ═══════════════════════════════════════════════════════════════════════

-- Ensure required extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;


-- Remove any prior versions of this job (including the original
-- unnamed auto-generated entry, if one is still present from earlier
-- migrations)
do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job
    where command ilike '%update-videos%'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end $$;


-- Schedule the daily update at 11:00 UTC
select cron.schedule(
  'hnm-update-videos-daily',
  '0 11 * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'hnm_project_url'
    ) || '/functions/v1/update-videos',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'hnm_cron_secret'
      )
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
