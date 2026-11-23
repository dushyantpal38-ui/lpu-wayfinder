-- LPU Wayfinder: per-caller limits (21 Nov 2026). Run once in the Supabase SQL Editor, BEFORE deploying the
-- site version that sends p_ip to log_visit (the old log_visit signature is replaced).
--
-- 1. Owner passcode: wrong tries are counted per caller IP, so one person guessing no longer locks the owner
--    out everywhere. A high global limit stays as a backstop against many IPs guessing together.
-- 2. Visits: opens are capped per caller IP (hashed by the site's server, cleared after about an hour), so one script can no
--    longer fill the global hourly cap and push out real visits.
-- shortcut: campus wifi and mobile carriers put many people behind one IP; the per-IP limits are set high
-- for that. If real visits get dropped at peak hours, raise them.

-- 1. Owner passcode tries per IP -----------------------------------------------------------------------------
create table if not exists private.owner_fails (
  ip text primary key,
  fails int not null default 0,
  last_fail timestamptz not null default now()
);
revoke all on table private.owner_fails from public, anon, authenticated;

-- The caller's IP as Supabase's edge (Cloudflare) sees it. Browsers cannot set cf-connecting-ip themselves.
create or replace function private.caller_ip()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(nullif(current_setting('request.headers', true), '')::json->>'cf-connecting-ip', ''), 'unknown');
$$;
revoke all on function private.caller_ip() from public, anon, authenticated;

create or replace function private.owner_ok(p text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s private.owner_secret%rowtype;
  h text;
  me text := private.caller_ip();
  mine private.owner_fails%rowtype;
begin
  if p like 'ows\_%' then
    h := encode(extensions.digest(p, 'sha256'), 'hex');
    update private.owner_sessions set last_used = now()
      where token_hash = h and expires_at > now();
    if found then return 'ok'; end if;
    return 'expired';
  end if;

  select * into s from private.owner_secret where id = 1 for update;
  if not found then
    return 'not_set';
  end if;
  select * into mine from private.owner_fails where ip = me;
  -- this caller: 6 tries an hour; everyone together: 100 an hour
  if (found and mine.fails >= 6 and mine.last_fail > now() - interval '1 hour')
     or (s.fails >= 100 and s.last_fail > now() - interval '1 hour') then
    return 'locked';
  end if;
  if s.hash = extensions.crypt(coalesce(p, ''), s.hash) then
    delete from private.owner_fails where ip = me;
    return 'ok';
  end if;
  update private.owner_secret
    set fails = case when s.last_fail > now() - interval '1 hour' then s.fails + 1 else 1 end,
        last_fail = now()
    where id = 1;
  insert into private.owner_fails (ip, fails, last_fail) values (me, 1, now())
    on conflict (ip) do update set
      fails = case when private.owner_fails.last_fail > now() - interval '1 hour' then private.owner_fails.fails + 1 else 1 end,
      last_fail = now();
  delete from private.owner_fails where last_fail < now() - interval '1 day';
  return 'wrong';
end;
$$;
revoke all on function private.owner_ok(text) from public, anon, authenticated;

-- 2. Visits per IP -------------------------------------------------------------------------------------------
alter table private.visits add column if not exists ip_hash text; -- sha256 of the IP; later visits clear it once it is over an hour old
create index if not exists visits_ip_idx on private.visits (ip_hash, created_at) where ip_hash is not null;

drop function if exists public.log_visit(text, uuid, text, boolean, text, text, text, text);
create or replace function public.log_visit(
  p_ingest text, p_visitor uuid, p_device text, p_app boolean, p_source text,
  p_city text, p_region text, p_country text, p_ip text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  fresh boolean;
  vid bigint;
  ip text := nullif(left(coalesce(p_ip, ''), 64), '');
begin
  if not private.ingest_ok(p_ingest) or p_visitor is null then
    return null;
  end if;
  -- flood limits: one phone 40 opens an hour, one IP 500, everyone together 20000
  if (select count(*) from private.visits where visitor = p_visitor and created_at > now() - interval '1 hour') >= 40
     or (ip is not null and (select count(*) from private.visits where ip_hash = ip and created_at > now() - interval '1 hour') >= 500)
     or (select count(*) from private.visits where created_at > now() - interval '1 hour') >= 20000 then
    return null;
  end if;

  insert into private.visitors (id, opens) values (p_visitor, 1)
    on conflict (id) do update set last_seen = now(), opens = private.visitors.opens + 1
    returning (xmax = 0) into fresh;

  insert into private.visits (visitor, is_new, device, app, source, city, region, country, ip_hash)
  values (
    p_visitor, fresh,
    case when p_device in ('phone', 'tablet', 'computer') then p_device end,
    p_app,
    nullif(left(regexp_replace(coalesce(p_source, ''), '[^A-Za-z0-9_-]', '', 'g'), 32), ''),
    nullif(left(btrim(coalesce(p_city, '')), 60), ''),
    nullif(left(btrim(coalesce(p_region, '')), 60), ''),
    nullif(upper(left(btrim(coalesce(p_country, '')), 2)), ''),
    ip
  )
  returning id into vid;

  if random() < 0.01 then
    update private.visits set ip_hash = null where ip_hash is not null and created_at < now() - interval '1 hour';
    delete from private.visits where created_at < now() - interval '13 months';
    delete from private.visitors where last_seen < now() - interval '13 months';
  end if;
  return vid;
end;
$$;

revoke all on function public.log_visit(text, uuid, text, boolean, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.log_visit(text, uuid, text, boolean, text, text, text, text, text) to anon, authenticated;
