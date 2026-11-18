"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { BlockPlate } from "@/components/block-plate";
import { useCampus } from "@/components/campus-provider";
import { isNamed } from "@/lib/campus";
import { ownerError, ownerStats, type OwnerStats } from "@/lib/admin";
import { cn } from "@/lib/utils";

// The owner's visitor numbers: new users, how often the site is opened, and from which part of the campus.
// Everything here is anonymous. A "person" is one phone (a random id kept on that phone), and a place is the
// nearest block to where the site was opened (only when the student has location on).

const RANGES = [7, 30, 90] as const;
const nf = new Intl.NumberFormat("en-IN");
const n = (v: number | null | undefined) => nf.format(v ?? 0);

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-inset ring-white/10">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums text-white">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {note && <p className="text-xs text-zinc-500">{note}</p>}
      </div>
      {children}
    </section>
  );
}

export function VisitorStats({ token, onSignedOut }: { token: string; onSignedOut: (code?: string | null) => void }) {
  const c = useCampus();
  const [days, setDays] = React.useState<number>(30);
  const [data, setData] = React.useState<OwnerStats | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const signedOut = React.useRef(onSignedOut);
  signedOut.current = onSignedOut;

  const load = React.useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await ownerStats(token, days);
      if (!r.ok) {
        if (r.error === "expired" || r.error === "wrong") { signedOut.current(r.error); return; }
        setErr(ownerError(r.error));
        return;
      }
      setData(r);
    } catch {
      setErr("Couldn't load the numbers. Check your internet and try again.");
    } finally {
      setBusy(false);
    }
  }, [token, days]);

  React.useEffect(() => { void load(); }, [load]);

  const catOf = (no: string) => c.db.find((r) => r.block_no === no)?.category || undefined;
  const placeTitle = (no: string | null, name: string | null) =>
    !no ? "" : no === "OPEN" ? "Open ground" : isNamed(no) ? name || no : `Block ${no}`;

  const t = data?.totals;
  const daily = data?.daily ?? [];
  const peak = Math.max(1, ...daily.map((d) => d.opens));
  const hours = data?.hours ?? [];
  const hourPeak = Math.max(1, ...hours);
  const areas = data?.areas;
  const areaTotal = areas ? areas.campus + areas.off_campus + areas.unknown : 0;
  const pct = (v: number) => (areaTotal ? Math.round((100 * v) / areaTotal) : 0);
  const devices = data?.devices ?? {};
  const sources = Object.entries(data?.sources ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-5 pb-2">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={days === r}
              onClick={() => setDays(r)}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm transition-colors",
                days === r ? "bg-amber-400 font-medium text-zinc-950" : "bg-white/[0.06] text-zinc-200 ring-1 ring-inset ring-white/10 hover:bg-white/10",
              )}
            >
              {r} days
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          aria-label="Refresh"
          title="Refresh"
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:bg-white/10 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
        </button>
      </div>

      {err && <p role="status" className="text-rose-300">{err}</p>}
      {!data && !err && <p className="text-zinc-400">Loading…</p>}

      {t && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Tile label="New users today" value={n(t.new_today)} hint={`${n(t.new_7d)} in the last 7 days`} />
            <Tile label="Opens today" value={n(t.opens_today)} hint={`${n(t.users_today)} ${t.users_today === 1 ? "person" : "people"}`} />
            <Tile label={`New users, ${days} days`} value={n(t.new_period)} hint={`${n(t.visitors_all_time)} people in all`} />
            <Tile label={`Opens, ${days} days`} value={n(t.opens_period)} hint={`${n(t.returning_period)} came back on another day`} />
          </div>

          <Section title="Every day" note="Bar = times the site was opened. Amber = new users that day.">
            {t.opens_period === 0 ? (
              <p className="text-zinc-400">No visits yet in this period.</p>
            ) : (
              <div className="flex h-24 items-end gap-[2px]" role="img" aria-label="Opens per day">
                {daily.map((d) => (
                  <div key={d.day} className="relative flex h-full flex-1 items-end" title={`${d.day}: ${d.opens} opens, ${d.new} new, ${d.users} people`}>
                    <div className="w-full rounded-t-sm bg-sky-500/70" style={{ height: `${(100 * d.opens) / peak}%` }} />
                    {d.new > 0 && <div className="absolute bottom-0 w-full rounded-t-sm bg-amber-400" style={{ height: `${(100 * d.new) / peak}%` }} />}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Where on campus they open it"
            note={`Nearest block to where the site was opened. Only when location is on (${n(t.with_location)} of ${n(t.opens_period)} opens).`}
          >
            {data.places && data.places.length ? (
              <ul className="space-y-1.5">
                {data.places.map((p) => (
                  <li key={p.place} className="flex items-center gap-2.5 rounded-xl bg-white/[0.04] p-2 ring-1 ring-inset ring-white/10">
                    <BlockPlate num={p.place === "OPEN" ? "OPEN" : p.place} category={p.place === "OPEN" ? "park" : catOf(p.place)} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-white">{placeTitle(p.place, p.name)}</span>
                      <span className="block text-xs leading-snug text-zinc-400">
                        {n(p.users)} {p.users === 1 ? "person" : "people"} · {p.per_user} opens each
                        {p.regulars > 0 ? ` · ${n(p.regulars)} regular${p.regulars === 1 ? "" : "s"} (3+ times)` : ""} · last {ago(p.last)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-base font-semibold tabular-nums text-white">{n(p.opens)}</span>
                      <span className="block text-[11px] text-zinc-500">opens</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-zinc-400">No locations yet. They appear when students with location on open the site.</p>
            )}
            {areas && areaTotal > 0 && (
              <p className="text-xs text-zinc-400">
                On campus {pct(areas.campus)}% · outside campus {pct(areas.off_campus)}% · location off {pct(areas.unknown)}%
              </p>
            )}
          </Section>

          {data.regulars && data.regulars.length > 0 && (
            <Section title="Most frequent users" note="Each row is one phone. No names are collected.">
              <ul className="space-y-1.5">
                {data.regulars.map((u, i) => (
                  <li key={`${u.id}-${i}`} className="flex items-center gap-2.5 rounded-xl bg-white/[0.04] p-2 ring-1 ring-inset ring-white/10">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-xs font-semibold text-zinc-300">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-white">
                        User #{u.id} · {n(u.opens)} opens on {n(u.days_active)} {u.days_active === 1 ? "day" : "days"}
                      </span>
                      <span className="block text-xs leading-snug text-zinc-400">
                        {u.top_place
                          ? `Mostly at ${placeTitle(u.top_place, u.top_place_name)} (${n(u.top_place_opens)}×)`
                          : "No location shared"}
                        {" · "}first {ago(u.first_seen)} · last {ago(u.last)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {hours.some((h) => h > 0) && (
            <Section title="Time of day" note="India time, 0 to 23 h.">
              <div className="flex h-14 items-end gap-[2px]" role="img" aria-label="Opens by hour of day">
                {hours.map((h, i) => (
                  <div key={i} className="flex h-full flex-1 items-end" title={`${i}:00 – ${h} opens`}>
                    <div className="w-full rounded-t-sm bg-sky-500/60" style={{ height: `${(100 * h) / hourPeak}%` }} />
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[11px] text-zinc-500"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
            </Section>
          )}

          {data.cities && data.cities.length > 0 && (
            <Section title="Cities" note="From the phone's internet connection, so it can be approximate.">
              <ul className="grid grid-cols-2 gap-1.5">
                {data.cities.map((ct) => (
                  <li key={`${ct.city}-${ct.country}`} className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2 ring-1 ring-inset ring-white/10">
                    <span className="min-w-0 truncate text-zinc-200">{ct.city}{ct.country && ct.country !== "IN" ? `, ${ct.country}` : ""}</span>
                    <span className="shrink-0 tabular-nums text-zinc-400">{n(ct.opens)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Devices">
            <p className="text-zinc-300">
              Phones {n(devices.phone)} · computers {n(devices.computer)} · tablets {n(devices.tablet)} · from the installed app {n(t.app_opens)}
            </p>
            {sources.length > 0 && (
              <p className="text-zinc-400">Links with ?src=: {sources.map(([k, v]) => `${k} ${n(v)}`).join(" · ")}</p>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
