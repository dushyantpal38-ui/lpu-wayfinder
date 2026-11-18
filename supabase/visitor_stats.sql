-- LPU Wayfinder: anonymous visitor stats (18 Nov 2026)
-- Each phone gets a random id (no name, no account). Every time the site is opened we log one visit. If the
-- student has location on, the server turns their position into the NEAREST BLOCK and stores only that;
-- the exact coordinates are never saved. Only the owner can read the numbers (owner_stats).
-- Writes come only from the site's own server (/api/visit), which holds the ingest key.

create table if not exists private.settings (
  key text primary key,
  value text not null
);
revoke all on table private.settings from public, anon, authenticated;

create table if not exists private.visitors (
  id uuid primary key,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  opens int not null default 0
);

create table if not exists private.visits (
  id bigint generated always as identity primary key,
  visitor uuid not null references private.visitors (id) on delete cascade,
  created_at timestamptz not null default now(),
  is_new boolean not null default false,
  device text,          -- phone / tablet / computer
  app boolean,          -- opened from the installed app (home-screen icon)
  source text,          -- ?src=... in the link (e.g. a QR poster), if any
  city text,            -- from the network (Vercel), e.g. Phagwara
  region text,
  country text,
  area text,            -- campus / off_campus / null (no location)
  place text,           -- block_no of the nearest block, or 'OPEN' (open ground on campus)
  place_name text
);
create index if not exists visits_created_idx on private.visits (created_at);
create index if not exists visits_visitor_idx on private.visits (visitor, created_at);
create index if not exists visits_place_idx on private.visits (place, created_at);
revoke all on table private.visitors, private.visits from public, anon, authenticated;

create or replace function private.ingest_ok(p text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.settings
    where key = 'visit_ingest_sha256' and value = encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
  );
$$;
revoke all on function private.ingest_ok(text) from public, anon, authenticated;

-- One open of the site. Returns the visit id (used once more to add the place), or null if refused.
create or replace function public.log_visit(
  p_ingest text, p_visitor uuid, p_device text, p_app boolean, p_source text,
  p_city text, p_region text, p_country text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  fresh boolean;
  vid bigint;
begin
  if not private.ingest_ok(p_ingest) or p_visitor is null then
    return null;
  end if;
  -- flood limits: one phone 40 opens an hour, everyone together 6000 an hour
  if (select count(*) from private.visits where visitor = p_visitor and created_at > now() - interval '1 hour') >= 40
     or (select count(*) from private.visits where created_at > now() - interval '1 hour') >= 6000 then
    return null;
  end if;

  insert into private.visitors (id, opens) values (p_visitor, 1)
    on conflict (id) do update set last_seen = now(), opens = private.visitors.opens + 1
    returning (xmax = 0) into fresh;

  insert into private.visits (visitor, is_new, device, app, source, city, region, country)
  values (
    p_visitor, fresh,
    case when p_device in ('phone', 'tablet', 'computer') then p_device end,
    p_app,
    nullif(left(regexp_replace(coalesce(p_source, ''), '[^A-Za-z0-9_-]', '', 'g'), 32), ''),
    nullif(left(btrim(coalesce(p_city, '')), 60), ''),
    nullif(left(btrim(coalesce(p_region, '')), 60), ''),
    nullif(upper(left(btrim(coalesce(p_country, '')), 2)), '')
  )
  returning id into vid;

  -- keep about 13 months of history
  if random() < 0.01 then
    delete from private.visits where created_at < now() - interval '13 months';
    delete from private.visitors where last_seen < now() - interval '13 months';
  end if;
  return vid;
end;
$$;

-- Adds where the visit happened. The coordinates are only used here, to find the nearest block, and are
-- never stored. Only within 30 minutes of the open, only once, and only by the same phone.
create or replace function public.visit_place(
  p_ingest text, p_visit bigint, p_visitor uuid, p_lng double precision, p_lat double precision)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  b record;
  v_area text;
  v_place text;
  v_name text;
  kx constant double precision := 111320 * cos(radians(31.25)); -- metres per degree of longitude here
  ky constant double precision := 110540;                        -- metres per degree of latitude
begin
  if not private.ingest_ok(p_ingest) or p_lng is null or p_lat is null
     or p_lng not between -180 and 180 or p_lat not between -90 and 90 then
    return null;
  end if;

  if p_lng between 75.68 and 75.73 and p_lat between 31.23 and 31.27 then
    v_area := 'campus';
    select block_no, name,
           sqrt(power((lng - p_lng) * kx, 2) + power((lat - p_lat) * ky, 2)) as d
      into b
      from public.campus_blocks
      where not coalesce(hidden, false) and lng is not null and lat is not null
      order by power((lng - p_lng) * kx, 2) + power((lat - p_lat) * ky, 2)
      limit 1;
    if found and b.d <= 120 then
      v_place := b.block_no;
      v_name := b.name;
    else
      v_place := 'OPEN';
      v_name := 'Open ground on campus';
    end if;
  else
    v_area := 'off_campus';
  end if;

  update private.visits
     set area = v_area, place = v_place, place_name = v_name
   where id = p_visit and visitor = p_visitor and area is null
     and created_at > now() - interval '30 minutes';
  if not found then
    return null;
  end if;
  return coalesce(v_place, v_area);
end;
$$;

revoke all on function public.log_visit(text, uuid, text, boolean, text, text, text, text),
                       public.visit_place(text, bigint, uuid, double precision, double precision)
  from public, anon, authenticated;
grant execute on function public.log_visit(text, uuid, text, boolean, text, text, text, text),
                          public.visit_place(text, bigint, uuid, double precision, double precision)
  to anon, authenticated; -- still useless without the ingest key, which only the site's server has

-- The owner's numbers. p_key: the owner's device token (or passcode). Days are counted in India time.
create or replace function public.owner_stats(p_key text, p_days int default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r text := private.owner_ok(p_key);
  n int := least(greatest(coalesce(p_days, 30), 1), 365);
  today date := (now() at time zone 'Asia/Kolkata')::date;
  since timestamptz := ((today - (n - 1))::timestamp at time zone 'Asia/Kolkata');
  res jsonb;
begin
  if r <> 'ok' then
    return jsonb_build_object('ok', false, 'error', r);
  end if;

  with v as (
    select *, (created_at at time zone 'Asia/Kolkata')::date as day,
           extract(hour from created_at at time zone 'Asia/Kolkata')::int as hr
    from private.visits where created_at >= since
  )
  select jsonb_build_object(
    'ok', true,
    'days', n,
    'totals', jsonb_build_object(
      'visitors_all_time', (select count(*) from private.visitors),
      'opens_all_time', (select count(*) from private.visits),
      'new_today', (select count(*) from v where is_new and day = today),
      'new_7d', (select count(*) from v where is_new and day > today - 7),
      'new_period', (select count(*) from v where is_new),
      'opens_today', (select count(*) from v where day = today),
      'opens_7d', (select count(*) from v where day > today - 7),
      'opens_period', (select count(*) from v),
      'users_today', (select count(distinct visitor) from v where day = today),
      'users_7d', (select count(distinct visitor) from v where day > today - 7),
      'users_period', (select count(distinct visitor) from v),
      'returning_period', (select count(*) from (select visitor from v group by visitor having count(distinct day) >= 2) x),
      'on_campus_share', (select round(100.0 * count(*) filter (where area = 'campus') / nullif(count(*) filter (where area is not null), 0)) from v),
      'with_location', (select count(*) from v where area is not null),
      'app_opens', (select count(*) from v where app)
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'opens', coalesce(x.opens, 0), 'new', coalesce(x.fresh, 0), 'users', coalesce(x.users, 0)) order by d.day)
      from (select (today - g)::date as day from generate_series(0, n - 1) g) d
      left join (select day, count(*) opens, count(*) filter (where is_new) fresh, count(distinct visitor) users from v group by day) x using (day)
    ), '[]'::jsonb),
    'hours', coalesce((
      select jsonb_agg(coalesce(x.c, 0) order by h)
      from generate_series(0, 23) h left join (select hr, count(*) c from v group by hr) x on x.hr = h
    ), '[]'::jsonb),
    'places', coalesce((
      select jsonb_agg(p order by (p->>'opens')::int desc) from (
        select jsonb_build_object(
          'place', place, 'name', max(place_name), 'opens', count(*), 'users', count(distinct visitor),
          'per_user', round(count(*)::numeric / count(distinct visitor), 1),
          'regulars', (select count(*) from (select 1 from v v2 where v2.place = v.place group by v2.visitor having count(*) >= 3) z),
          'last', max(created_at)) p
        from v where place is not null group by place order by count(*) desc limit 40
      ) t
    ), '[]'::jsonb),
    'areas', jsonb_build_object(
      'campus', (select count(*) from v where area = 'campus'),
      'off_campus', (select count(*) from v where area = 'off_campus'),
      'unknown', (select count(*) from v where area is null)
    ),
    'cities', coalesce((
      select jsonb_agg(c order by (c->>'opens')::int desc) from (
        select jsonb_build_object('city', coalesce(city, 'Unknown'), 'country', country, 'opens', count(*), 'users', count(distinct visitor)) c
        from v group by city, country order by count(*) desc limit 12
      ) t
    ), '[]'::jsonb),
    'devices', coalesce((
      select jsonb_object_agg(coalesce(device, 'unknown'), c) from (select device, count(*) c from v group by device) t
    ), '{}'::jsonb),
    'sources', coalesce((
      select jsonb_object_agg(source, c) from (select source, count(*) c from v where source is not null group by source) t
    ), '{}'::jsonb),
    'regulars', coalesce((
      select jsonb_agg(u order by (u->>'opens')::int desc) from (
        select jsonb_build_object(
          'id', left(visitor::text, 6),
          'opens', count(*),
          'days_active', count(distinct day),
          'first_seen', (select first_seen from private.visitors where id = visitor),
          'last', max(created_at),
          'top_place', (select place from v v2 where v2.visitor = v.visitor and place is not null group by place order by count(*) desc limit 1),
          'top_place_name', (select max(place_name) from v v2 where v2.visitor = v.visitor and place is not null group by place order by count(*) desc limit 1),
          'top_place_opens', (select count(*) from v v2 where v2.visitor = v.visitor and place is not null group by place order by count(*) desc limit 1)
        ) u
        from v group by visitor order by count(*) desc limit 15
      ) t
    ), '[]'::jsonb)
  ) into res;
  return res;
end;
$$;
revoke all on function public.owner_stats(text, int) from public, anon, authenticated;
grant execute on function public.owner_stats(text, int) to anon, authenticated;
