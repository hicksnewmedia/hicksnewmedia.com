-- ════════════════════════════════════════════════════════════════════════
-- Migration: notify on new newsletter subscriber
-- ════════════════════════════════════════════════════════════════════════
-- Fires an async HTTP POST to Resend whenever a row is inserted into
-- newsletter_subscribers. Uses the same Vault secrets as the inquiry
-- notification trigger (hnm_resend_key, hnm_inquiry_recipient).
--
-- Notes:
-- • pg_net = async, so Resend failures never block the signup insert.
-- • Email format mirrors the inquiry notification for visual consistency.
-- • If you want to silence these later (volume gets noisy), just drop the
--   trigger: drop trigger notify_new_subscriber_trigger on newsletter_subscribers;
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_new_subscriber()
returns trigger
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  resend_key text;
  recipient  text;
  email_html text;
begin
  select decrypted_secret into resend_key
    from vault.decrypted_secrets
    where name = 'hnm_resend_key';

  select decrypted_secret into recipient
    from vault.decrypted_secrets
    where name = 'hnm_inquiry_recipient';

  if resend_key is null or recipient is null then
    raise notice 'Resend secrets not configured — skipping notification for subscriber %', new.id;
    return new;
  end if;

  email_html := format($html$
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; max-width: 600px; color: #0a0a0a;">
  <h2 style="border-bottom: 2px solid #f48022; padding-bottom: 8px; margin-bottom: 16px;">
    New Newsletter Subscriber
  </h2>
  <table style="width: 100%%; border-collapse: collapse; margin-bottom: 16px;">
    <tr><td style="padding: 6px 12px 6px 0; vertical-align: top;"><strong>Email:</strong></td><td style="padding: 6px 0;"><a href="mailto:%s" style="color: #20557b;">%s</a></td></tr>
    <tr><td style="padding: 6px 12px 6px 0; vertical-align: top;"><strong>Source:</strong></td><td style="padding: 6px 0;">%s</td></tr>
    <tr><td style="padding: 6px 12px 6px 0; vertical-align: top;"><strong>Referer:</strong></td><td style="padding: 6px 0;">%s</td></tr>
  </table>
  <hr style="margin: 16px 0; border: 0; border-top: 1px solid #ddd;">
  <p style="font-size: 12px; color: #888; line-height: 1.5;">
    Submitted at %s<br>
    User agent: %s
  </p>
  <p style="font-size: 12px; color: #888; line-height: 1.5; margin-top: 12px;">
    They'll receive Substack's confirmation email separately. This row is captured in your own database (newsletter_subscribers).
  </p>
</div>
  $html$,
    new.email, new.email,
    coalesce(new.source, 'unknown'),
    coalesce(new.referer, '—'),
    new.created_at,
    coalesce(new.user_agent, '—')
  );

  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || resend_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object(
      'from',    'HNM Notifications <onboarding@resend.dev>',
      'to',      jsonb_build_array(recipient),
      'subject', format('New subscriber: %s', new.email),
      'html',    email_html
    )
  );

  return new;
end;
$$;

drop trigger if exists notify_new_subscriber_trigger on public.newsletter_subscribers;

create trigger notify_new_subscriber_trigger
  after insert on public.newsletter_subscribers
  for each row
  execute function public.notify_new_subscriber();
