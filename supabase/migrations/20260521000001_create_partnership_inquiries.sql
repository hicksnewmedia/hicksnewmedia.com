-- ════════════════════════════════════════════════════════════════════════
-- Migration: create partnership_inquiries table
-- ════════════════════════════════════════════════════════════════════════
-- Receives contact form submissions from hicksnewmedia.com.
--
-- Security model:
--   • RLS is enabled.
--   • The anon role can ONLY INSERT, and only if the payload passes the
--     WITH CHECK validation (length limits + empty honeypot).
--   • The authenticated role can SELECT/UPDATE for admin triage later.
--   • The service_role bypasses RLS automatically (for dashboards/exports).
--
-- The 'source' column is the honeypot. The form renders an invisible
-- input named "source" — humans never see it, bots fill every field.
-- Any non-empty value is rejected at the database boundary.
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

create table if not exists public.partnership_inquiries (
  id            uuid          primary key default gen_random_uuid(),
  created_at    timestamptz   not null default now(),

  -- Inquiry payload
  name          text          not null,
  email         text          not null,
  company       text,
  inquiry       text          not null,
  message       text          not null,

  -- Spam protection (honeypot — must be empty)
  source        text,

  -- Submission metadata
  user_agent    text,
  referer       text,

  -- Triage state (managed by you in the dashboard, not by the form)
  status        text          not null default 'new'
                check (status in ('new', 'in_progress', 'replied', 'closed', 'spam')),
  read_at       timestamptz,
  notes         text
);

-- Indexes for triage / sorting
create index if not exists partnership_inquiries_created_at_idx
  on public.partnership_inquiries (created_at desc);

create index if not exists partnership_inquiries_status_idx
  on public.partnership_inquiries (status)
  where status <> 'closed';

-- ════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- ════════════════════════════════════════════════════════════════════════
alter table public.partnership_inquiries enable row level security;

-- Anon: INSERT only, with strict validation. No SELECT/UPDATE/DELETE.
create policy "anon can insert valid inquiries"
  on public.partnership_inquiries
  for insert
  to anon
  with check (
    length(name)    between 1 and 200
    and length(email)   between 3 and 200
    and length(message) between 1 and 5000
    and length(coalesce(company, ''))    <= 200
    and length(coalesce(inquiry, ''))    <=  100
    and length(coalesce(user_agent, '')) <=  500
    and length(coalesce(referer, ''))    <=  500
    and coalesce(length(source), 0) = 0          -- honeypot must be empty
    and email like '%@%.%'                       -- basic email shape
  );

-- Authenticated (your admin login, if you ever add one): full read/update
create policy "authenticated can read inquiries"
  on public.partnership_inquiries
  for select
  to authenticated
  using (true);

create policy "authenticated can update inquiries"
  on public.partnership_inquiries
  for update
  to authenticated
  using (true)
  with check (true);

-- Note: no DELETE policy — even authenticated users can't delete.
-- If you ever need to purge, use service_role or remove this comment.

-- ════════════════════════════════════════════════════════════════════════
-- Notification (optional, configure in Supabase UI after migration runs)
-- ════════════════════════════════════════════════════════════════════════
-- To get a Slack/email ping when a new inquiry lands:
--   1. Database → Webhooks → Create a new hook
--   2. Table: partnership_inquiries
--   3. Events: INSERT
--   4. URL: your Slack incoming webhook URL (or Resend / Zapier / etc.)
--   5. HTTP headers as needed
-- This keeps the migration clean (no hard-coded URLs in SQL) and lets you
-- swap the notification target without touching the database.
-- ════════════════════════════════════════════════════════════════════════
