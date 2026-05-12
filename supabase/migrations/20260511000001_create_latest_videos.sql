-- ════════════════════════════════════════════════════════════════════
-- HicksNewMedia.com — latest_videos table
-- ════════════════════════════════════════════════════════════════════
-- Source of truth for the "From the Channel" section on the website.
-- The update-videos Edge Function writes here; the site reads from here
-- via the Supabase REST API using the public anon key.

create table if not exists public.latest_videos (
  id                text        primary key,
  title             text        not null,
  published_at      timestamptz not null,
  duration_seconds  integer     not null default 0,
  thumbnail_url     text        not null,
  category_label    text        not null,
  updated_at        timestamptz not null default now()
);

comment on table  public.latest_videos                  is 'Latest videos shown in the From the Channel section of hicksnewmedia.com';
comment on column public.latest_videos.id               is 'YouTube video ID (the ?v= parameter)';
comment on column public.latest_videos.category_label   is 'Editorial label derived from duration: Short, Quick Take, Brief, or Long-form';
comment on column public.latest_videos.published_at     is 'When the video was published to YouTube';

create index if not exists latest_videos_published_at_idx
  on public.latest_videos (published_at desc);

-- ════════════════════════════════════════════════════════════════════
-- Row Level Security: public read, write only via service role
-- ════════════════════════════════════════════════════════════════════
alter table public.latest_videos enable row level security;

-- Public (anon key) can read everything in this table
drop policy if exists "anon read latest videos" on public.latest_videos;
create policy "anon read latest videos"
  on public.latest_videos
  for select
  to anon, authenticated
  using (true);

-- Inserts/updates/deletes happen only via the Edge Function using the
-- service role key, which bypasses RLS by default. No additional policies
-- needed for write — the absence of a write policy denies all anon writes.
