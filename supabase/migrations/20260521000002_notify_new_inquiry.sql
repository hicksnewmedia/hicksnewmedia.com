-- ════════════════════════════════════════════════════════════════════════
-- Migration: notify on new partnership inquiry
-- ════════════════════════════════════════════════════════════════════════
-- Fires an async HTTP POST to Resend whenever a row is inserted into
-- partnership_inquiries. James receives an email with the inquiry details.
--
-- ─── ONE-TIME SETUP (run these BEFORE this migration is useful) ────────
--
-- 1. Sign up at https://resend.com (GitHub SSO, free tier: 3000/mo).
-- 2. In the Resend dashboard, create an API key. Copy it.
-- 3. In Supabase SQL Editor, store both secrets in Vault:
--
--      select vault.create_secret(
--        'paste_your_resend_api_key_here',
--        'hnm_resend_key',
--        'Resend API key for partnership inquiry notifications'
--      );
--
--      select vault.create_secret(
--        'paste_your_email_address_here',
--        'hnm_inquiry_recipient',
--        'Email address that receives partnership inquiry notifications'
--      );
--
-- 4. Then run this migration.
--
-- ─── NOTES ─────────────────────────────────────────────────────────────
--
-- • pg_net makes the HTTP call asynchronously. If Resend is down or slow,
--   the row INSERT still succeeds. The inquiry is durably stored either way.
-- • If either vault secret is missing, the trigger logs a notice and skips
--   the email rather than failing the insert.
-- • The 'from' address uses Resend's default verified sender. To send from
--   inquiries@hicksnewmedia.com later, verify the domain in Resend and
--   update the 'from' field below.
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_new_inquiry()
returns trigger
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  resend_key  text;
  recipient   text;
  email_html  text;
begin
  -- Pull secrets from Vault
  select decrypted_secret into resend_key
    from vault.decrypted_secrets
    where name = 'hnm_resend_key';

  select decrypted_secret into recipient
    from vault.decrypted_secrets
    where name = 'hnm_inquiry_recipient';

  -- If secrets aren't configured, skip email but don't fail the insert
  if resend_key is null or recipient is null then
    raise notice 'Resend secrets not configured — skipping email notification for inquiry %', new.id;
    return new;
  end if;

  -- Build the email body
  email_html := format($html$
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; max-width: 600px; color: #0a0a0a;">
  <h2 style="border-bottom: 2px solid #f48022; padding-bottom: 8px; margin-bottom: 16px;">
    New Partnership Inquiry
  </h2>
  <table style="width: 100%%; border-collapse: collapse; margin-bottom: 16px;">
    <tr><td style="padding: 6px 12px 6px 0; vertical-align: top;"><strong>From:</strong></td><td style="padding: 6px 0;">%s</td></tr>
    <tr><td style="padding: 6px 12px 6px 0; vertical-align: top;"><strong>Email:</strong></td><td style="padding: 6px 0;"><a href="mailto:%s" style="color: #20557b;">%s</a></td></tr>
    <tr><td style="padding: 6px 12px 6px 0; vertical-align: top;"><strong>Company:</strong></td><td style="padding: 6px 0;">%s</td></tr>
    <tr><td style="padding: 6px 12px 6px 0; vertical-align: top;"><strong>Inquiry Type:</strong></td><td style="padding: 6px 0;">%s</td></tr>
  </table>
  <div style="font-weight: 600; margin-bottom: 8px;">Brief</div>
  <div style="padding: 14px 16px; background: #f5f1eb; border-left: 3px solid #f48022; white-space: pre-wrap; line-height: 1.5;">%s</div>
  <hr style="margin: 24px 0; border: 0; border-top: 1px solid #ddd;">
  <p style="font-size: 12px; color: #888; line-height: 1.5;">
    Submitted at %s<br>
    Referer: %s<br>
    User agent: %s
  </p>
</div>
  $html$,
    new.name,
    new.email, new.email,
    coalesce(new.company, '—'),
    new.inquiry,
    new.message,
    new.created_at,
    coalesce(new.referer, '—'),
    coalesce(new.user_agent, '—')
  );

  -- Fire the POST request asynchronously
  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || resend_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object(
      'from',     'HNM Inquiries <onboarding@resend.dev>',
      'to',       jsonb_build_array(recipient),
      'reply_to', new.email,
      'subject',  format('New inquiry: %s — %s', new.inquiry, new.name),
      'html',     email_html
    )
  );

  return new;
end;
$$;

-- (Re-)create the trigger
drop trigger if exists notify_new_inquiry_trigger on public.partnership_inquiries;

create trigger notify_new_inquiry_trigger
  after insert on public.partnership_inquiries
  for each row
  execute function public.notify_new_inquiry();
