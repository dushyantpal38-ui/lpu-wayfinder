"use client";

import * as React from "react";
import { ChevronUp, DoorOpen, Download, Search, Star, X } from "lucide-react";
import { LiveCampusMap } from "@/components/live-campus-map";
import { ShaderBackground } from "@/components/ui/shader-background";
import { AdminEditor } from "@/components/admin-editor";
import { useCampus } from "@/components/campus-provider";
import { BlockPlate } from "@/components/block-plate";
import { distanceMetres, searchBlocks, type Block, type Pt } from "@/lib/campus";
import { formatDistance, parseRoom } from "@/lib/places";
import { cn } from "@/lib/utils";

const CATEGORY: Record<string, string> = { academic: "Academic block", hostel: "Hostel", food: "Food and shops", park: "Park", sports: "Sports", other: "Building" };

function subtitle(b: Block) {
  return `${CATEGORY[b.category] || "Building"}${b.placed ? "" : ", not on the map yet"}`;
}

const CHIPS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "saved", label: "Saved" },
  { id: "academic", label: "Academic" },
  { id: "hostel", label: "Hostels" },
  { id: "food", label: "Food" },
  { id: "park", label: "Parks" },
  { id: "other", label: "Other" },
];

// Places offered before the student has typed anything.
const QUICK = ["34", "UNIMALL", "UNIPOLIS", "13"];
const RECENT_KEY = "lpuRecent";
const HINT_KEY = "lpuSearchHintSeen";

type InstallPrompt = Event & { prompt: () => Promise<void> };

/** A place as a small tappable pill: its plate and its name. */
function PlaceChip({ b, onPick }: { b: Block; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex shrink-0 items-center gap-2 rounded-full bg-white/[0.06] py-1 pl-1 pr-3.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      <BlockPlate num={b.num} category={b.category} size="sm" className="rounded-full bg-white/10 ring-0" />
      <span className="max-w-[10rem] truncate">{b.name}</span>
    </button>
  );
}

// The live campus map fills the screen. The search button opens the block list
// (a sheet from the bottom on phones, a panel on the left on computers).
export function LpuWayfinder() {
  const { blocks, db, loading, editing } = useCampus();
  const [query, setQuery] = React.useState("");
  const [destination, setDestination] = React.useState<string | null>(null);
  const [room, setRoom] = React.useState<string | null>(null); // from a timetable code like 34-204
  const [sheet, setSheet] = React.useState<"half" | "full">("half"); // phone only: how tall the list is when open
  const [open, setOpen] = React.useState(false); // the block list stays hidden until the search button is pressed
  const drag = React.useRef<number | null>(null);
  const [chip, setChip] = React.useState("all");
  const [saved, setSaved] = React.useState<string[]>([]);
  const [recent, setRecent] = React.useState<string[]>([]);
  const [navigating, setNavigating] = React.useState(false);
  const [me, setMe] = React.useState<Pt | null>(null); // the student, while on campus
  const [hint, setHint] = React.useState(false); // first visit: point at the search button
  const [installer, setInstaller] = React.useState<InstallPrompt | null>(null);
  const [desktop, setDesktop] = React.useState(false);
  const itemRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const searchInput = React.useRef<HTMLInputElement>(null);
  const asideRef = React.useRef<HTMLElement>(null);
  const sheetScroll = React.useRef<HTMLDivElement>(null); // scrolls the whole sheet (phones)
  const listScroll = React.useRef<HTMLDivElement>(null); // scrolls just the list (computers)
  const wanted = React.useRef<{ b: string; r: string | null } | null | undefined>(undefined); // block from a shared link

  React.useEffect(() => {
    try { setSaved(JSON.parse(localStorage.getItem("lpuSavedBlocks") || "[]")); } catch { /* ignore */ }
    try { setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) || "[]")); } catch { /* ignore */ }
    try { if (!localStorage.getItem(HINT_KEY)) setHint(true); } catch { /* ignore */ }
  }, []);

  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // The browser's offer to install the site as an app (Chrome, Edge, Android).
  React.useEffect(() => {
    const offer = (e: Event) => { e.preventDefault(); setInstaller(e as InstallPrompt); };
    const done = () => setInstaller(null);
    window.addEventListener("beforeinstallprompt", offer);
    window.addEventListener("appinstalled", done);
    return () => { window.removeEventListener("beforeinstallprompt", offer); window.removeEventListener("appinstalled", done); };
  }, []);
  const install = async () => {
    const e = installer;
    setInstaller(null);
    try { await e?.prompt(); } catch { /* ignore */ }
  };

  // A shared link (?b=34&r=204) opens the map on that block as soon as the block list has it.
  React.useEffect(() => {
    if (wanted.current === undefined) {
      try {
        const p = new URLSearchParams(window.location.search);
        const b = (p.get("b") || "").trim().toUpperCase();
        wanted.current = b ? { b, r: (p.get("r") || "").trim().toUpperCase() || null } : null;
      } catch { wanted.current = null; }
    }
    const w = wanted.current;
    if (!w) return;
    if (!blocks.some((x) => x.num === w.b)) {
      if (db.length) wanted.current = null; // saved blocks are in and it is not one of them: forget the link
      return;
    }
    wanted.current = null;
    setRoom(w.r);
    setDestination(w.b);
  }, [blocks, db]);

  // Keep the address in step with the picked block, so it can be copied or bookmarked.
  React.useEffect(() => {
    if (wanted.current) return; // still waiting to open a shared link
    try {
      const u = new URL(window.location.href);
      if (destination) {
        u.searchParams.set("b", destination);
        if (room) u.searchParams.set("r", room); else u.searchParams.delete("r");
      } else {
        u.searchParams.delete("b");
        u.searchParams.delete("r");
      }
      window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
    } catch { /* ignore */ }
  }, [destination, room]);

  React.useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(false), 9000);
    return () => window.clearTimeout(t);
  }, [hint]);

  const hideHint = () => {
    setHint(false);
    try { localStorage.setItem(HINT_KEY, "1"); } catch { /* ignore */ }
  };

  // Remember the last few places, newest first.
  React.useEffect(() => {
    if (!destination) return;
    hideHint();
    setRecent((cur) => {
      const next = [destination, ...cur.filter((x) => x !== destination)].slice(0, 6);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [destination]);

  const toggleSaved = (num: string) => {
    setSaved((cur) => {
      const next = cur.includes(num) ? cur.filter((x) => x !== num) : [...cur, num];
      try { localStorage.setItem("lpuSavedBlocks", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const list = React.useMemo(() => {
    const found = searchBlocks(blocks, query);
    if (chip === "all") return found;
    if (chip === "saved") return found.filter((b) => saved.includes(b.num));
    if (chip === "other") return found.filter((b) => !["academic", "hostel", "food", "park"].includes(b.category));
    return found.filter((b) => b.category === chip);
  }, [blocks, query, chip, saved]);

  // "34-204" is block 34, room 204.
  const roomHit = React.useMemo(() => {
    const r = parseRoom(query);
    if (!r) return null;
    const b = blocks.find((x) => x.num === r.block);
    return b ? { b, room: r.room } : null;
  }, [query, blocks]);

  const byNum = (n: string) => blocks.find((b) => b.num === n);
  const recentBlocks = recent.map(byNum).filter((b): b is Block => !!b);
  const quickBlocks = QUICK.filter((n) => !recent.includes(n)).map(byNum).filter((b): b is Block => !!b);
  const showPicks = !query && chip === "all";
  const away = (b: Block) => (me && b.c ? formatDistance(distanceMetres(me, b.c)) : null);

  // On a phone, close the list after picking so the map is visible. On a computer, keep it open.
  const pick = (num: string, r: string | null = null) => {
    setRoom(r);
    setDestination(num);
    if (!desktop) { setOpen(false); setQuery(""); searchInput.current?.blur(); }
  };
  const openList = () => {
    setOpen(true);
    setSheet("half");
    hideHint();
    sheetScroll.current?.scrollTo({ top: 0 });
    // Phones show the list first; the keyboard comes up when the search box is tapped.
    if (desktop) window.setTimeout(() => searchInput.current?.focus({ preventScroll: true }), 250);
  };
  // Enter goes straight to the best match.
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomHit) pick(roomHit.b.num, roomHit.room);
    else if (query.trim() && list[0]) pick(list[0].num);
  };

  // While the list is closed, nothing inside it can be reached with the keyboard.
  React.useEffect(() => { asideRef.current?.toggleAttribute("inert", !open); }, [open]);

  // On a computer, picking a block on the map brings it into view in the open list. Only the list scrolls,
  // never the page (scrollIntoView would also scroll the page and push the map's buttons off screen).
  React.useEffect(() => {
    if (!open || !desktop || !destination) return;
    const el = itemRefs.current[destination], box = listScroll.current;
    if (!el || !box) return;
    const c = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top < c.top || r.bottom > c.bottom) box.scrollTo({ top: box.scrollTop + r.top - c.top - (c.height - r.height) / 2, behavior: "smooth" });
  }, [destination, open, desktop]);

  return (
    <main
      className="relative isolate flex h-[100svh] w-full flex-col overflow-hidden bg-zinc-950 text-white md:flex-row"
      onScroll={(e) => { const t = e.currentTarget; if (t.scrollTop || t.scrollLeft) { t.scrollTop = 0; t.scrollLeft = 0; } }}
    >
      {/* Animated shader behind the whole website. The map and the panel sit on top of it. It is switched off
          while walking, when the phone already runs GPS and the map, to save battery. */}
      {!navigating && <ShaderBackground className="absolute inset-0 z-[-1]" />}
      <section className="absolute inset-0">
        <AdminEditor onStart={() => { setDestination(null); setRoom(null); setOpen(false); }} />
        <LiveCampusMap
          destination={destination}
          room={room}
          editing={editing}
          panelOpen={open && desktop}
          onDestinationChange={(n) => { setRoom(null); setDestination(n); if (n && !desktop) setOpen(false); }}
          onNavigatingChange={setNavigating}
          onUserChange={setMe}
        />
      </section>

      {/* Search button, middle of the left edge. It opens the block list. */}
      {!open && !navigating && !editing && (
        <div className="absolute left-4 top-1/2 z-30 flex -translate-y-1/2 items-center gap-3">
          <button
            type="button"
            aria-label="Search blocks"
            title="Search blocks"
            onClick={openList}
            className="relative flex h-14 w-14 items-center justify-center rounded-full bg-sky-500 text-white shadow-[0_8px_28px_rgba(14,165,233,0.45)] ring-1 ring-white/20 transition hover:bg-sky-400 active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky-300/60"
          >
            {hint && <span className="absolute inset-0 rounded-full bg-sky-400/50 motion-safe:animate-ping" aria-hidden />}
            <Search className="relative h-6 w-6" aria-hidden />
          </button>
          {hint && (
            <button type="button" onClick={openList} className="relative rounded-xl bg-white px-3.5 py-2 text-sm font-semibold text-zinc-900 shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
              <span className="absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 rounded-[2px] bg-white" aria-hidden />
              <span className="relative">Find a block</span>
            </button>
          )}
        </div>
      )}

      {/* Blocks (bottom sheet on phones, left panel on computers). Hidden until the search button is pressed. */}
      <aside
        ref={asideRef}
        aria-hidden={!open}
        aria-label="Find a block"
        style={{ "--sheet-h": sheet === "half" ? "58svh" : "92svh" } as React.CSSProperties}
        className={cn(
          "absolute inset-x-0 bottom-0 z-40 flex h-[var(--sheet-h)] flex-col overflow-hidden rounded-t-3xl bg-zinc-950/95 backdrop-blur-xl shadow-[0_-8px_30px_rgba(0,0,0,0.5)] ring-1 ring-white/10 transition-[height,transform,opacity] duration-300",
          "md:inset-x-auto md:bottom-0 md:left-0 md:top-0 md:h-auto md:w-[440px] md:rounded-none md:rounded-r-3xl md:shadow-[8px_0_30px_rgba(0,0,0,0.5)] lg:w-[480px]",
          open ? "translate-x-0 translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0 md:-translate-x-full md:translate-y-0",
          navigating && "max-md:hidden",
        )}
      >
        <div ref={sheetScroll} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)] md:overflow-hidden">
          <button
            type="button"
            aria-label="Make the list taller or shorter"
            onClick={() => setSheet((v) => (v === "half" ? "full" : "half"))}
            onTouchStart={(e) => { drag.current = e.touches[0].clientY; }}
            onTouchEnd={(e) => {
              if (drag.current === null) return;
              const dy = e.changedTouches[0].clientY - drag.current;
              drag.current = null;
              if (Math.abs(dy) < 12) return;
              if (dy < 0) setSheet("full");
              else if (sheet === "full") setSheet("half");
              else setOpen(false); // dragging down from half height closes the list
            }}
            className="sticky top-0 z-10 flex w-full shrink-0 items-center justify-center bg-zinc-950/90 py-2.5 backdrop-blur md:hidden"
          >
            <span className="h-1.5 w-11 rounded-full bg-white/30" />
            <ChevronUp className={cn("absolute right-4 h-5 w-5 text-white/50 transition-transform", sheet === "full" && "rotate-180")} aria-hidden />
          </button>

          <header className="flex shrink-0 items-center gap-2 px-5 pb-3 pt-1 md:pt-6">
            <h2 className="min-w-0 flex-1 text-xl font-semibold tracking-tight text-white">Find a block</h2>
            {installer && (
              <button
                type="button"
                onClick={install}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-sky-500/15 px-3 text-sm font-medium text-sky-200 ring-1 ring-inset ring-sky-400/30 hover:bg-sky-500/25"
              >
                <Download className="h-4 w-4" aria-hidden /> Install app
              </button>
            )}
            <button
              type="button"
              aria-label="Close the list"
              title="Close"
              onClick={() => setOpen(false)}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-zinc-300 hover:bg-white/20 hover:text-white"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </header>

          <form role="search" onSubmit={submit} className="shrink-0 px-5 pb-3">
            <label className="flex h-12 items-center gap-3 rounded-2xl bg-white/[0.06] px-4 text-white ring-1 ring-inset ring-white/10 focus-within:ring-2 focus-within:ring-sky-400">
              <Search className="h-5 w-5 shrink-0 text-zinc-400" aria-hidden />
              <input
                ref={searchInput}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSheet("full")}
                placeholder="34, 34-204 or Unimall"
                aria-label="Search a block number, room or name"
                enterKeyHint="go"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="h-full w-full bg-transparent text-base outline-none placeholder:text-zinc-500"
              />
              {query && (
                <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); searchInput.current?.focus(); }} className="text-zinc-400 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              )}
            </label>
          </form>

          {showPicks && recentBlocks.length > 0 && (
            <section className="shrink-0 pb-3">
              <h3 className="px-5 pb-2 text-sm font-medium text-zinc-400">Recent</h3>
              <div className="flex gap-2 overflow-x-auto px-5 [scrollbar-width:none]">
                {recentBlocks.map((b) => <PlaceChip key={b.num} b={b} onPick={() => pick(b.num)} />)}
              </div>
            </section>
          )}
          {showPicks && quickBlocks.length > 0 && (
            <section className="shrink-0 pb-3">
              <h3 className="px-5 pb-2 text-sm font-medium text-zinc-400">Quick picks</h3>
              <div className="flex gap-2 overflow-x-auto px-5 [scrollbar-width:none]">
                {quickBlocks.map((b) => <PlaceChip key={b.num} b={b} onPick={() => pick(b.num)} />)}
              </div>
            </section>
          )}

          <div className="flex shrink-0 gap-2 overflow-x-auto px-5 pb-2 [scrollbar-width:none]">
            {CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setChip(c.id)}
                aria-pressed={chip === c.id}
                className={cn(
                  "shrink-0 rounded-full px-4 py-1.5 text-sm transition-colors",
                  chip === c.id ? "bg-sky-500 font-medium text-white" : "bg-white/[0.06] text-zinc-200 ring-1 ring-inset ring-white/10 hover:bg-white/10",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
          {!roomHit && (
            <p className="shrink-0 px-5 pb-2 text-xs text-zinc-500">
              {list.length} {list.length === 1 ? "place" : "places"}
            </p>
          )}

          <div ref={listScroll} className="shrink-0 space-y-1 px-3 pb-10 [scrollbar-width:thin] md:min-h-0 md:flex-1 md:shrink md:overflow-y-auto md:pb-6">
            {roomHit && (
              <button
                type="button"
                onClick={() => pick(roomHit.b.num, roomHit.room)}
                className="flex w-full items-center gap-3 rounded-2xl bg-sky-500/10 p-2.5 text-left ring-1 ring-inset ring-sky-400/30 hover:bg-sky-500/15"
              >
                <BlockPlate num={roomHit.b.num} category={roomHit.b.category} tone="solid" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium text-white">Room {roomHit.room} in block {roomHit.b.num}</span>
                  <span className="block truncate text-xs text-zinc-400">{roomHit.b.name}</span>
                </span>
                <DoorOpen className="h-5 w-5 shrink-0 text-sky-300" aria-hidden />
              </button>
            )}
            {loading && !list.length && <p className="px-2 text-sm text-zinc-500">Loading blocks…</p>}
            {!loading && !list.length && !roomHit && (
              <p className="px-2 text-sm text-zinc-400">
                {chip === "saved"
                  ? "Tap the star on a block to keep it here."
                  : query
                    ? `No block matches “${query}”. Try a number like 34, a room like 34-204, or a name like Unimall.`
                    : "Nothing here yet."}
              </p>
            )}
            {list.map((b) => {
              const on = b.num === destination;
              const d = away(b);
              return (
                <div
                  key={b.num}
                  className={cn(
                    "flex w-full items-center gap-1 rounded-2xl pr-1 transition-colors",
                    on ? "bg-sky-500/10 ring-1 ring-inset ring-sky-400/40" : "hover:bg-white/[0.06]",
                  )}
                >
                  <button
                    ref={(el) => { itemRefs.current[b.num] = el; }}
                    type="button"
                    onClick={() => pick(b.num)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                  >
                    <BlockPlate num={b.num} category={b.category} tone={on ? "solid" : "quiet"} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-medium text-zinc-50">{b.name}</span>
                      <span className="block truncate text-xs text-zinc-400">{subtitle(b)}</span>
                    </span>
                    {d && <span className="shrink-0 text-xs tabular-nums text-zinc-400">{d}</span>}
                  </button>
                  <button
                    type="button"
                    aria-label={saved.includes(b.num) ? "Remove from saved" : "Save this block"}
                    aria-pressed={saved.includes(b.num)}
                    onClick={() => toggleSaved(b.num)}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-500 hover:text-amber-400"
                  >
                    <Star className={cn("h-5 w-5", saved.includes(b.num) && "fill-amber-400 text-amber-400")} />
                  </button>
                </div>
              );
            })}
            <p className="px-2 pt-6 text-[11px] leading-relaxed text-zinc-600">
              Privacy: this app counts visits anonymously (a random id on this phone, no names). If location is on,
              only the nearest block is saved, never your exact position.
            </p>
          </div>
        </div>
      </aside>
    </main>
  );
}
