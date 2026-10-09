-- The scheduler of the Supabase readers. Paste into Dashboard > SQL Editor of the
-- project, once, after deploying the function reader (supabase/reader.mjs).
-- Nothing secret is written in this file: the two markers below are replaced by
-- the owner in the editor and the edited text is never saved anywhere else.
-- The signing secrets (INGEST_LATEST_SUPA_US / _EU) never come here: they live
-- only in the function's secrets, so pg_net, which keeps request headers in
-- net.* for hours, never sees them.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Vault. Paste (a) the function's address, https://<project>.supabase.co/functions/v1/reader,
-- and (b) the same 128 hex that is the function secret READER_KEY.
select vault.create_secret('<PASTE THE FUNCTION ADDRESS HERE>', 'reader_url');
select vault.create_secret('<PASTE THE VALUE OF READER_KEY HERE>', 'reader_key');

-- 2. The beat: one row per call, so the project shows activity and the Free plan
-- does not pause it. RLS on and no policy; no grant to the API's roles.
create table if not exists public.heartbeat (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  region text not null,
  request_id bigint
);
alter table public.heartbeat enable row level security;
revoke all on public.heartbeat from public, anon, authenticated;

-- 3. The call. Fixed body, secret in a header, 10 s timeout. x-region only routes
-- the call to a region; the function trusts its own SB_REGION, and answers 404 if
-- the two differ.
create or replace function public.call_reader(p_region text) returns void
language plpgsql
set search_path = ''
as $$
declare
  rid bigint;
begin
  if p_region not in ('us-east-1', 'eu-central-1') then
    raise exception 'region';
  end if;
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'reader_url'),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-region', p_region,
      'x-wvw-key', (select decrypted_secret from vault.decrypted_secrets where name = 'reader_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  ) into rid;
  insert into public.heartbeat (region, request_id) values (p_region, rid);
end;
$$;
revoke all on function public.call_reader(text) from public, anon, authenticated;

-- 4. Every 2 minutes, both sides; and a daily cleanup of the beat.
select cron.schedule('reader-us', '*/2 * * * *', $$select public.call_reader('us-east-1')$$);
select cron.schedule('reader-eu', '*/2 * * * *', $$select public.call_reader('eu-central-1')$$);
select cron.schedule('heartbeat-cleanup', '17 3 * * *',
  $$delete from public.heartbeat where at < now() - interval '7 days'$$);

-- To stop:  select cron.unschedule('reader-us'); select cron.unschedule('reader-eu');
