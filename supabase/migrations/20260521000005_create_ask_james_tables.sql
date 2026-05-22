-- ════════════════════════════════════════════════════════════════════════
-- Migration: Ask James chatbot tables
-- ════════════════════════════════════════════════════════════════════════
-- Three tables back the Ask James AI chatbot:
--   1. ask_james_rate_limit  — IP-based hourly rate limiting (20 msg/hr)
--   2. ask_james_usage_daily — daily budget tracking ($5/day, $50/month caps)
--   3. ask_james_conversations — full conversation logs for analytics
--
-- All tables locked down with RLS. Only the service_role key (used by the
-- Netlify Function server-side) can read/write. No anon access.
-- ════════════════════════════════════════════════════════════════════════

-- ─── Rate limiting (IP-based, hourly bucket) ───────────────────────────
create table if not exists public.ask_james_rate_limit (
  ip_hash       text primary key,
  request_count integer not null default 0,
  window_start  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists ask_james_rate_limit_window_idx
  on public.ask_james_rate_limit (window_start desc);

alter table public.ask_james_rate_limit enable row level security;
-- No policies = no anon access. Only service_role can read/write.

comment on table public.ask_james_rate_limit is
  'Tracks request count per hashed IP for the current 1-hour window. Reset by Netlify Function logic.';


-- ─── Daily usage / budget tracking ─────────────────────────────────────
create table if not exists public.ask_james_usage_daily (
  day            date primary key default current_date,
  input_tokens   bigint not null default 0,
  output_tokens  bigint not null default 0,
  cost_usd       numeric(10,4) not null default 0,
  request_count  integer not null default 0,
  updated_at     timestamptz not null default now()
);

alter table public.ask_james_usage_daily enable row level security;
-- No policies = no anon access.

comment on table public.ask_james_usage_daily is
  'Aggregate token usage and cost per day. Used to enforce daily and monthly budget caps.';


-- ─── Conversation logging ──────────────────────────────────────────────
create table if not exists public.ask_james_conversations (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  session_id     text not null,
  ip_hash        text,
  user_message   text not null,
  assistant_msg  text,
  tool_used      text,
  input_tokens   integer,
  output_tokens  integer,
  cost_usd       numeric(10,4),
  intent         text,
  lead_captured  boolean default false,
  user_agent     text,
  referer        text
);

create index if not exists ask_james_conversations_session_idx
  on public.ask_james_conversations (session_id, created_at);

create index if not exists ask_james_conversations_created_idx
  on public.ask_james_conversations (created_at desc);

create index if not exists ask_james_conversations_intent_idx
  on public.ask_james_conversations (intent)
  where intent is not null;

create index if not exists ask_james_conversations_leads_idx
  on public.ask_james_conversations (created_at desc)
  where lead_captured = true;

alter table public.ask_james_conversations enable row level security;
-- No policies = no anon access.

comment on table public.ask_james_conversations is
  'Full Ask James chatbot conversation logs. Each row = one user message + assistant response pair.';


-- ─── Helper function: get current month's spend (for monthly cap check) ─
create or replace function public.ask_james_month_spend()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0)
  from public.ask_james_usage_daily
  where day >= date_trunc('month', current_date)::date;
$$;

comment on function public.ask_james_month_spend is
  'Returns total cost_usd spent this month across daily usage rows.';
