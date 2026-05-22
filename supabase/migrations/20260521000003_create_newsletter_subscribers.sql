-- ════════════════════════════════════════════════════════════════════════
-- Migration: create newsletter_subscribers table + RLS
-- ════════════════════════════════════════════════════════════════════════
-- Captures every newsletter signup from the site in your own database
-- BEFORE forwarding to Substack. This is the "own your list" pattern —
-- if you migrate from Substack to Beehiiv/ConvertKit/anywhere later,
-- the list comes with you.
--
-- Status lifecycle:
--   pending     → row just inserted, Substack forward not confirmed
--   subscribed  → confirmed via Substack double opt-in (manual or webhook)
--   unsubscribed → opted out (manual update)
--   spam        → flagged manually
-- ════════════════════════════════════════════════════════════════════════

create table if not exists public.newsletter_subscribers (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  email         text not null,
  source        text,
  user_agent    text,
  referer       text,
  status        text not null default 'pending',
  confirmed_at  timestamptz,
  notes         text,
  constraint email_format check (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  constraint status_valid check (status in ('pending', 'subscribed', 'unsubscribed', 'spam'))
);

-- Case-insensitive uniqueness on email (so foo@x.com and FOO@x.com collide)
create unique index if not exists newsletter_subscribers_email_unique
  on public.newsletter_subscribers (lower(email));

create index if not exists newsletter_subscribers_created_at_idx
  on public.newsletter_subscribers (created_at desc);

create index if not exists newsletter_subscribers_status_idx
  on public.newsletter_subscribers (status)
  where status != 'subscribed';

-- ─── RLS ───────────────────────────────────────────────────────────────
alter table public.newsletter_subscribers enable row level security;

-- Anon (public visitors) can insert valid signups, nothing else
drop policy if exists "anon can insert newsletter signups" on public.newsletter_subscribers;
create policy "anon can insert newsletter signups"
  on public.newsletter_subscribers
  for insert
  to anon
  with check (
    length(email) <= 254
    and email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
    and (source is null or length(source) <= 50)
    and (user_agent is null or length(user_agent) <= 500)
  );

-- Authenticated (you, via Studio) can read all subscribers
drop policy if exists "authenticated can read subscribers" on public.newsletter_subscribers;
create policy "authenticated can read subscribers"
  on public.newsletter_subscribers
  for select
  to authenticated
  using (true);

-- Authenticated can update status, confirmed_at, notes
drop policy if exists "authenticated can update subscribers" on public.newsletter_subscribers;
create policy "authenticated can update subscribers"
  on public.newsletter_subscribers
  for update
  to authenticated
  using (true);

-- Note: no DELETE policy — only service_role can delete, which is correct
-- for an email list (audit trail matters more than convenience here).

comment on table public.newsletter_subscribers is
  'Newsletter signups captured from hicksnewmedia.com before being forwarded to Substack. Owned by HNM, portable to any provider.';
