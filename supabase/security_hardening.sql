-- LPU Wayfinder: security hardening (18 Nov 2026)
-- 1. Visitors can only READ the map. Every write grant they don't need is removed (RLS already blocked
--    them; this is a second lock on the same door).
-- 2. Feedback and route suggestions stay open to everyone, but with a flood limit.
-- 3. Owner sign-in: the passcode is sent once and swapped for a device token that expires. The passcode is
--    no longer stored on the phone. Wrong passcodes: 6 tries, then locked for 1 hour.
-- 4. The old backup table moves out of the public API.

-- 1. Grants ---------------------------------------------------------------------------------------------
revoke all on table public.campus_blocks, public.campus_labels, public.campus_reports, public.campus_routes
  from anon, authenticated;
grant select on table public.campus_blocks, public.campus_labels to anon, authenticated;
grant select, insert on table public.campus_routes to anon, authenticated; -- RLS: read approved, submit unapproved
grant insert on table public.campus_reports to anon, authenticated;          -- RLS: send only, nobody can read

alter table public.campus_blocks_backup_20261117 set schema private;
revoke all on table private.campus_blocks_backup_20261117 from anon, authenticated;

-- 2. Flood limits on the two tables anyone can write to -------------------------------------------------
create or replace function private.flood_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent int;
  today int;
begin
  if tg_table_name = 'campus_reports' then
    select count(*) filter (where created_at > now() - interval '10 minutes'),
           count(*) filter (where created_at > now() - interval '1 day')
      into recent, today from public.campus_reports where created_at > now() - interval '1 day';
  else
    select count(*) filter (where created_at > now() - interval '10 minutes'),
           count(*) filter (where created_at > now() - interval '1 day')
      into recent, today from public.campus_routes where created_at > now() - interval '1 day';
  end if;
  if recent >= 30 or today >= 300 then
    raise exception 'too_many' using errcode = 'P0001', hint = 'Too many messages right now. Try again later.';
  end if;
  new.created_at := now(); -- never trust a time sent by the browser
  return new;
end;
$$;
revoke all on function private.flood_guard() from public, anon, authenticated;

drop trigger if exists campus_reports_flood on public.campus_reports;
create trigger campus_reports_flood before insert on public.campus_reports for each row execute function private.flood_guard();
drop trigger if exists campus_routes_flood on public.campus_routes;
create trigger campus_routes_flood before insert on public.campus_routes for each row execute function private.flood_guard();
create index if not exists campus_reports_created_idx on public.campus_reports (created_at);
create index if not exists campus_routes_created_idx on public.campus_routes (created_at);

-- 3. Owner device tokens ---------------------------------------------------------------------------------
create table if not exists private.owner_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used timestamptz
);
revoke all on table private.owner_sessions from public, anon, authenticated;

-- Checks a passcode OR a device token. Returns ok / wrong / locked / not_set / expired.
create or replace function private.owner_ok(p text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s private.owner_secret%rowtype;
  h text;
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
  if s.fails >= 6 and s.last_fail > now() - interval '1 hour' then
    return 'locked';
  end if;
  if s.hash = extensions.crypt(coalesce(p, ''), s.hash) then
    if s.fails > 0 then
      update private.owner_secret set fails = 0, last_fail = null where id = 1;
    end if;
    return 'ok';
  end if;
  update private.owner_secret
    set fails = case when s.last_fail > now() - interval '1 hour' then s.fails + 1 else 1 end,
        last_fail = now()
    where id = 1;
  return 'wrong';
end;
$$;
revoke all on function private.owner_ok(text) from public, anon, authenticated;

-- Passcode in, device token out (valid 30 days). At most 5 devices stay signed in.
create or replace function public.owner_login(p_pass text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r text;
  tok text;
begin
  if p_pass like 'ows\_%' then
    return jsonb_build_object('ok', false, 'error', 'wrong');
  end if;
  r := private.owner_ok(p_pass);
  if r <> 'ok' then
    return jsonb_build_object('ok', false, 'error', r);
  end if;
  tok := 'ows_' || encode(extensions.gen_random_bytes(32), 'hex');
  delete from private.owner_sessions where expires_at < now();
  insert into private.owner_sessions (token_hash, expires_at)
    values (encode(extensions.digest(tok, 'sha256'), 'hex'), now() + interval '30 days');
  delete from private.owner_sessions where token_hash in (
    select token_hash from private.owner_sessions order by created_at desc offset 5);
  return jsonb_build_object('ok', true, 'token', tok);
end;
$$;

-- Lock: forget this device's token on the server too.
create or replace function public.owner_logout(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.owner_sessions where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  return jsonb_build_object('ok', true);
end;
$$;

-- Sign every device out (run in the SQL Editor if a phone is lost): select owner_logout_all();
create or replace function public.owner_logout_all()
returns text
language sql
security definer
set search_path = ''
as $$
  with d as (delete from private.owner_sessions returning 1) select 'Signed out ' || count(*) || ' device(s).' from d;
$$;

revoke all on function public.owner_login(text), public.owner_logout(text), public.owner_logout_all() from public, anon, authenticated;
grant execute on function public.owner_login(text), public.owner_logout(text) to anon, authenticated;
-- owner_logout_all stays SQL-Editor only.
