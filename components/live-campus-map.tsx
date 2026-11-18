"use client";

import * as React from "react";
import type { Map as MLMap } from "maplibre-gl";
import { Flag, LocateFixed, MapPin, Maximize, Navigation, Navigation2, RotateCcw, RotateCw, Share2, X } from "lucide-react";
import { CampusMap } from "@/components/campus-map";
import { useCampus } from "@/components/campus-provider";
import { BlockPlate } from "@/components/block-plate";
import { campusBounds, distanceMetres, GATE, insideCampus, isGateName, isNamed, titleOf, type Pt } from "@/lib/campus";
import { formatDistance } from "@/lib/places";
import { bearingAhead, buildGraph, findRoute, progressAlong, type Route } from "@/lib/routing";
import { cn } from "@/lib/utils";

// The full live map: your blue dot, the whole campus, and a walking line to the block you pick.

export type LiveCampusMapProps = {
  /** Block to go to (picked in the list or on the map). */
  destination?: string | null;
  onDestinationChange?: (num: string | null) => void;
  /** Tells the page when walking navigation is running, so it can hide the block list. */
  onNavigatingChange?: (on: boolean) => void;
  /** Where the student is while they are on campus (null otherwise). The list uses it for distances. */
  onUserChange?: (user: Pt | null) => void;
  /** Room inside the destination block, from a timetable code like 34-204. */
  room?: string | null;
  /** The block list is open on the left (computers only): keep the map's buttons and cards clear of it. */
  panelOpen?: boolean;
  /** The owner is editing the map: the editor takes the bottom of the screen. */
  editing?: boolean;
  className?: string;
};

type Geo = "idle" | "asking" | "on" | "denied" | "unavailable";

// Direction the map turns to as someone arrives at the main gate from outside (degrees; negative turns left).
const GATE_BEARING = -35;
// The camera the map opens with on campus.
const START_VIEW = { zoom: 17.8, pitch: 60, bearing: 0 };
const LAST_FIX_KEY = "lpuLastFix"; // last spot on campus, so the next visit opens there straight away

// Dark glass used by everything that floats over the map.
const GLASS = "bg-zinc-950/90 ring-1 ring-white/10 backdrop-blur-xl shadow-[0_8px_30px_rgba(0,0,0,0.45)]";

type SavedFix = { lng: number; lat: number; t: number };
function readLastFix(): SavedFix | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_FIX_KEY) || "null") as SavedFix | null;
    if (!v || typeof v.lng !== "number" || typeof v.lat !== "number") return null;
    return Date.now() - v.t < 12 * 3600 * 1000 ? v : null; // only trust it for 12 hours
  } catch { return null; }
}

/** One button in the map's button stack. */
function MapButton({ label, onClick, active, pressed, children }: {
  label: string; onClick: () => void; active?: boolean; pressed?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex h-11 w-11 items-center justify-center text-zinc-200 transition-colors hover:bg-white/10 active:bg-white/15",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400",
        active && "text-sky-400",
      )}
    >
      {children}
    </button>
  );
}

export function LiveCampusMap({ destination = null, onDestinationChange, onNavigatingChange, onUserChange, room = null, panelOpen = false, editing = false, className }: LiveCampusMapProps) {
  const { fc, blocks } = useCampus();
  const [map, setMap] = React.useState<MLMap | null>(null);
  const [threeD, setThreeD] = React.useState(false); // flat, facing the viewer; the 3D button tilts it
  const [bearing, setBearing] = React.useState(0);
  const [hint, setHint] = React.useState(false);
  const [geo, setGeo] = React.useState<Geo>("idle");
  const [user, setUser] = React.useState<Pt | null>(null);
  const [accuracy, setAccuracy] = React.useState<number | null>(null);
  const watch = React.useRef<number | null>(null);
  const [navigating, setNavigating] = React.useState(false);
  const [follow, setFollow] = React.useState(false);
  const [heading, setHeading] = React.useState<number | null>(null);
  const [outside, setOutside] = React.useState(false); // outside the campus: stop tracking, show the gate
  const [toast, setToast] = React.useState<string | null>(null);
  const [askClosed, setAskClosed] = React.useState(false); // the location card was closed
  const centred = React.useRef(false);
  const gotFix = React.useRef(false);
  const preJumped = React.useRef(false); // opened at the last saved spot while waiting for a fresh fix
  const touched = React.useRef(false); // the person has moved the map themselves
  const centredAt = React.useRef(0); // when the opening view was set
  const toastTimer = React.useRef<number | undefined>(undefined);

  // A short message near the bottom that goes away by itself.
  const say = React.useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4500);
  }, []);
  React.useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // Keep the compass in step with the map as it turns.
  React.useEffect(() => {
    if (!map) return;
    const on = () => setBearing(map.getBearing());
    on();
    map.on("rotate", on);
    return () => { map.off("rotate", on); };
  }, [map]);

  // On a phone, tell people once that they can turn the map with two fingers.
  React.useEffect(() => {
    if (!map) return;
    try {
      if (!window.matchMedia("(pointer: coarse)").matches || localStorage.getItem("lpuRotateHint")) return;
      localStorage.setItem("lpuRotateHint", "1");
    } catch { return; }
    setHint(true);
    const t = window.setTimeout(() => setHint(false), 7000);
    return () => window.clearTimeout(t);
  }, [map]);

  const dest = destination ? blocks.find((b) => b.num === destination) || null : null;
  const onCampus = !!(user && fc && insideCampus(fc, user));

  // Tell the page where the student is (on campus only), for distances in the list.
  const onUserRef = React.useRef(onUserChange);
  onUserRef.current = onUserChange;
  React.useEffect(() => { onUserRef.current?.(onCampus && !outside ? user : null); }, [user, onCampus, outside]);

  const startLocation = React.useCallback(() => {
    if (!("geolocation" in navigator)) { setGeo("unavailable"); return; }
    setGeo("asking");
    setAskClosed(false);
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    const onPos = (pos: GeolocationPosition) => {
      gotFix.current = true;
      if (pos.coords.accuracy <= 500) {
        try { localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ lng: pos.coords.longitude, lat: pos.coords.latitude, t: Date.now() })); } catch { /* ignore */ }
      }
      setGeo("on");
      setUser([pos.coords.longitude, pos.coords.latitude]);
      setAccuracy(pos.coords.accuracy);
      setHeading(typeof pos.coords.heading === "number" && !Number.isNaN(pos.coords.heading) && (pos.coords.speed ?? 0) > 0.6 ? pos.coords.heading : null);
    };
    const follow = (high: boolean) => {
      watch.current = navigator.geolocation.watchPosition(
        onPos,
        (err) => {
          if (err.code === 1) { setGeo("denied"); return; } // blocked by the person
          if (gotFix.current) return; // keep the last known spot on a brief GPS drop
          if (high) { // GPS too slow indoors: fall back to network location
            if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
            follow(false);
          } else {
            setGeo("unavailable");
          }
        },
        { enableHighAccuracy: high, maximumAge: high ? 3000 : 60000, timeout: high ? 12000 : 30000 },
      );
    };
    // A quick fix first so the map opens at the student straight away (the phone's last known
    // position comes back at once), then follow with GPS.
    navigator.geolocation.getCurrentPosition(onPos, () => {}, { enableHighAccuracy: false, maximumAge: 10 * 60 * 1000, timeout: 4000 });
    follow(true);
  }, []);

  // Ask for the location as soon as the page opens.
  React.useEffect(() => { startLocation(); }, [startLocation]);

  React.useEffect(() => () => { if (watch.current !== null) navigator.geolocation.clearWatch(watch.current); }, []);

  // Remember when the person moves the map, so a late GPS fix does not pull the view away from them.
  React.useEffect(() => {
    if (!map) return;
    const on = (e: { originalEvent?: unknown }) => { if (e.originalEvent) touched.current = true; };
    map.on("dragstart", on);
    map.on("zoomstart", on);
    map.on("rotatestart", on);
    return () => { map.off("dragstart", on); map.off("zoomstart", on); map.off("rotatestart", on); };
  }, [map]);

  // Opening view, instant (no fly-in animation).
  // 1. As soon as the map is ready, jump to the last spot this phone was on campus, if there is one.
  React.useEffect(() => {
    if (!map || !fc || centred.current || preJumped.current || dest || user) return;
    const last = readLastFix();
    if (!last || !insideCampus(fc, [last.lng, last.lat])) return;
    preJumped.current = true;
    setThreeD(true);
    map.jumpTo({ center: [last.lng, last.lat], ...START_VIEW });
  }, [map, fc, dest, user]);

  // 2. When a real fix arrives, jump to the student (on campus) or to the main gate (outside, or no location).
  React.useEffect(() => {
    if (!map || !fc || centred.current || dest) return;
    const noLocation = geo === "denied" || geo === "unavailable";
    if (!noLocation && (!user || accuracy === null)) return;
    const inside = !!(user && insideCampus(fc, user));
    // A rough fix inside the campus is enough to go there now; the dot sharpens as GPS settles.
    // Deciding "outside" needs a better fix (within 150 m), so a rough reading does not send someone to the gate.
    if (!noLocation && !inside && (accuracy ?? Infinity) > 150) return;
    if (!noLocation && inside && (accuracy ?? Infinity) > 500) return;
    centred.current = true;
    centredAt.current = Date.now();
    setThreeD(true);
    if (inside && user) {
      if (preJumped.current) {
        if (!touched.current) map.easeTo({ center: user, duration: 300 }); // already close by: a short slide
      } else {
        map.jumpTo({ center: user, ...START_VIEW });
      }
      return;
    }
    // Outside (or no location): stop tracking the person, hide their dot, and show the campus from the main gate.
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    setOutside(true);
    // The main gate is the place the owner named "Main gate" (or the GATE setting in lib/campus.ts, if it is set).
    const gatePlace = blocks.find((b) => b.c && isGateName(b.name))?.c;
    const gateSpot = fc.features.find((f) => f.properties.gate)?.properties.c;
    const target: Pt | null | undefined = GATE ?? gatePlace ?? gateSpot;
    if (!noLocation) say(target ? "You're outside the campus, so the map starts at the main gate." : "You're outside the campus. Pick a block to see where it is.");
    if (target) map.jumpTo({ center: target, zoom: 17.8, pitch: 62, bearing: GATE_BEARING });
  }, [map, user, fc, dest, geo, accuracy, say]); // eslint-disable-line react-hooks/exhaustive-deps

  // Someone who opened the map outside (or with location blocked) and is now on campus with location on:
  // show their dot again and let routes start from them.
  React.useEffect(() => {
    if (outside && user && onCampus && accuracy !== null && accuracy <= 150) setOutside(false);
  }, [outside, user, onCampus, accuracy]);

  // While the first minute's GPS fixes get sharper, keep the view on the student unless they have moved the map.
  React.useEffect(() => {
    if (!map || !user || !centred.current || outside || navigating || dest || touched.current || !accuracy || accuracy > 60) return;
    if (Date.now() - centredAt.current > 60000) return; // only during the first minute
    const c = map.getCenter();
    const far = Math.hypot((c.lng - user[0]) * 95000, (c.lat - user[1]) * 110000) > 25;
    if (far) map.easeTo({ center: user, duration: 300 });
  }, [map, user, accuracy, outside, navigating, dest]); // eslint-disable-line react-hooks/exhaustive-deps

  const showCampus = () => {
    const b = fc && campusBounds(fc);
    if (map && b) map.fitBounds(b as never, { padding: { top: 90, bottom: 120, left: 24, right: 72 }, pitch: threeD ? 45 : 0, bearing: 0, duration: 800 });
  };
  const toMe = () => {
    if (geo !== "on") { startLocation(); return; }
    if (!onCampus) { say("You're outside the campus right now."); return; }
    if (navigating) { setFollow(true); return; }
    if (map && user) map.flyTo({ center: user, zoom: Math.max(map.getZoom(), 17), duration: 800 });
  };
  const faceNorth = () => map?.easeTo({ bearing: 0, pitch: threeD ? 45 : 0, duration: 500 });
  const rotate = (d: number) => map?.easeTo({ bearing: map.getBearing() + d, duration: 350 });

  const graph = React.useMemo(() => (fc ? buildGraph(fc) : null), [fc]);
  // The route ends at the nearest side of the building (or of its own part, in a connected complex).
  const destRing = dest?.feature && dest.feature.geometry.type === "Polygon" ? dest.feature.geometry.coordinates[0] : null;
  // While walking, the route is kept steady: it only shortens behind the student, and is worked out
  // afresh only if they wander more than 25 m off it.
  const kept = React.useRef<{ num: string; coords: Pt[]; metres: number } | null>(null);
  const walk: Route | null = React.useMemo(() => {
    if (!graph || !user || !dest || !dest.c || !onCampus) return null;
    const k = kept.current;
    if (navigating && k && k.num === dest.num) {
      const p = progressAlong(k.coords, user);
      if (p.off <= 25) return { coords: p.ahead, metres: p.metresLeft, onRoads: true };
    }
    const r = findRoute(graph, user, dest.c, destRing);
    if (navigating) kept.current = { num: dest.num, coords: r.coords, metres: Math.max(k && k.num === dest.num ? k.metres : 0, r.metres) };
    return r;
  }, [graph, user, dest, destRing, onCampus, navigating]);
  const route: Pt[] | null = walk && walk.coords.length > 1 ? walk.coords : null;
  const metres = walk ? Math.round(walk.metres) : null;
  const minutes = metres !== null ? Math.max(1, Math.round(metres / 80)) : null; // about 4.8 km/h
  const straight = user && dest && dest.c && onCampus ? distanceMetres(user, dest.c) : null;
  const arrived = navigating && metres !== null && metres <= 15;
  const progress = navigating && kept.current && metres !== null && kept.current.metres > 0
    ? Math.min(1, Math.max(0, 1 - metres / kept.current.metres)) : 0;

  const startNav = () => {
    kept.current = walk && dest ? { num: dest.num, coords: walk.coords, metres: walk.metres } : null;
    setNavigating(true); setFollow(true); onNavigatingChange?.(true);
  };
  const endNav = () => {
    kept.current = null;
    setNavigating(false); setFollow(false); onNavigatingChange?.(false);
    map?.easeTo({ bearing: 0, pitch: threeD ? 45 : 0, duration: 600 });
  };

  // Leaving the destination ends navigation.
  React.useEffect(() => { if (!dest && navigating) endNav(); }, [dest]); // eslint-disable-line react-hooks/exhaustive-deps

  // While navigating, glide along with the student and face the way the route goes. The map only turns
  // for a real change of direction (over 20 degrees), so it does not wobble with every GPS reading.
  const facing = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!map || !navigating || !follow || !user) { facing.current = null; return; }
    const ahead = route ? bearingAhead(route, 25) : null;
    const want = heading ?? ahead;
    const now = map.getBearing();
    let bearing = facing.current ?? now;
    if (want !== null) {
      let diff = want - bearing;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      if (facing.current === null || Math.abs(diff) > 20) bearing = want;
    }
    facing.current = bearing;
    map.easeTo({ center: user, zoom: 18.2, pitch: threeD ? 55 : 0, bearing, duration: 1000, easing: (t) => t, essential: true });
  }, [map, navigating, follow, user, heading, threeD]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dragging the map pauses following; the locate button resumes it.
  React.useEffect(() => {
    if (!map) return;
    const stop = (e: { originalEvent?: unknown }) => { if (e.originalEvent) setFollow(false); };
    map.on("dragstart", stop);
    return () => { map.off("dragstart", stop); };
  }, [map]);

  // When a block is picked on campus, show the whole walk: you and the block together, clear of the card.
  const framed = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!dest) { framed.current = null; return; }
    if (!map || !route || route.length < 2 || navigating || framed.current === dest.num) return;
    framed.current = dest.num;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    route.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
    const wide = window.matchMedia("(min-width: 768px)").matches;
    map.fitBounds([[x0, y0], [x1, y1]], {
      padding: { top: 110, bottom: wide ? 200 : 240, left: wide && panelOpen ? 520 : 96, right: 80 },
      maxZoom: 18.2, pitch: threeD ? 50 : 0, duration: 900,
    });
  }, [map, dest, route, navigating]); // eslint-disable-line react-hooks/exhaustive-deps

  // Send a link that opens the map on this block (and room).
  const share = async () => {
    if (!dest) return;
    const url = `${window.location.origin}/?b=${encodeURIComponent(dest.num)}${room ? `&r=${encodeURIComponent(room)}` : ""}`;
    const title = isNamed(dest.num) ? dest.name : `Block ${dest.num}${room ? `, room ${room}` : ""}`;
    const text = isNamed(dest.num) ? `${dest.name} on the LPU campus map` : `${title} (${dest.name}) on the LPU campus map`;
    try {
      if (navigator.share) { await navigator.share({ title, text, url }); return; }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return; // closed the share sheet
    }
    try {
      await navigator.clipboard.writeText(url);
      say("Link copied. Paste it in any chat.");
    } catch {
      say(url);
    }
  };

  // The line under the destination's name.
  const destLine = !dest
    ? ""
    : !dest.placed
      ? "Not on the map yet"
      : geo === "asking" && !user
        ? "Finding your location…"
        : !user
          ? "Turn on location to see the walk"
          : !onCampus
            ? "You're outside the campus"
            : metres !== null && metres <= 15
              ? "You're here"
              : metres !== null && minutes !== null
                ? `${minutes} min walk, ${formatDistance(metres)}`
                : straight !== null
                  ? `${formatDistance(straight)} away`
                  : "";

  // The status line in the top corner.
  const status: { text: string; tone: "on" | "out" | "wait" | "off" } =
    geo === "denied"
      ? { text: "Location is off", tone: "off" }
      : geo === "unavailable"
        ? { text: "Location unavailable", tone: "off" }
        : !user
          ? { text: "Finding your location…", tone: "wait" }
          : onCampus
            ? { text: accuracy !== null && accuracy > 80 ? "On campus (rough location)" : "On campus", tone: "on" }
            : { text: "Outside the campus", tone: "out" };

  // The main button on the destination card.
  const primary: "walk" | "location" | null = walk && onCampus && (metres ?? 0) > 15 ? "walk" : geo === "denied" || geo === "unavailable" ? "location" : null;

  const askLocation = !dest && !navigating && !askClosed && (geo === "idle" || geo === "denied" || geo === "unavailable");
  const ask = geo === "denied"
    ? { title: "Location is blocked", body: "Allow location for this site in your browser settings, then try again.", cta: "Try again" }
    : geo === "unavailable"
      ? { title: "Can't find your location", body: "Turn on your phone's location and try again.", cta: "Try again" }
      : { title: "See where you are", body: "Your location stays on this phone.", cta: "Allow location" };

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-transparent", className)}>
      <CampusMap
        mode="live" activeNum={destination} user={outside ? null : user} route={route} threeD={threeD}
        onMap={setMap} onPickBlock={(n) => onDestinationChange?.(n)}
      />

      {/* Name and status, top left */}
      <div className={cn(
        "pointer-events-none absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] z-20 max-w-[calc(100%-5.25rem)] md:left-4 md:top-4",
        panelOpen && "md:left-[456px] lg:left-[496px]",
      )}>
        <div className={cn("flex items-center gap-2.5 rounded-2xl py-1.5 pl-1.5 pr-3.5", GLASS)}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-500 text-white">
            <MapPin className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold leading-tight text-white">LPU Wayfinder</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs leading-tight text-zinc-400">
              <span className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                status.tone === "on" && "bg-emerald-400",
                status.tone === "out" && "bg-amber-400",
                status.tone === "wait" && "bg-sky-400 motion-safe:animate-pulse",
                status.tone === "off" && "bg-zinc-500",
              )} />
              <span className="truncate">{status.text}</span>
            </span>
          </span>
        </div>
      </div>

      {/* Map buttons, top right */}
      <div className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-20 flex flex-col items-end gap-2 md:right-4 md:top-4">
        <div className={cn("flex flex-col divide-y divide-white/10 overflow-hidden rounded-2xl", GLASS)}>
          <MapButton label="Show my location" onClick={toMe} active={geo === "on" && onCampus}>
            <LocateFixed className="h-5 w-5" />
          </MapButton>
          <MapButton label="3D view" onClick={() => setThreeD((v) => !v)} active={threeD} pressed={threeD}>
            <span className="font-sign text-[17px] font-bold leading-none">3D</span>
          </MapButton>
          <MapButton label="Show the whole campus" onClick={showCampus}>
            <Maximize className="h-[18px] w-[18px]" />
          </MapButton>
        </div>
        {/* Phones turn the map with two fingers; computers get buttons. */}
        <div className={cn("hidden flex-col divide-y divide-white/10 overflow-hidden rounded-2xl md:flex", GLASS)}>
          <MapButton label="Rotate left" onClick={() => rotate(-30)}><RotateCcw className="h-[18px] w-[18px]" /></MapButton>
          <MapButton label="Rotate right" onClick={() => rotate(30)}><RotateCw className="h-[18px] w-[18px]" /></MapButton>
        </div>
        {Math.abs(bearing) > 1 && (
          <button
            type="button"
            aria-label="Turn the map to face north"
            title="Face north"
            onClick={faceNorth}
            className={cn("flex h-11 w-11 items-center justify-center rounded-full text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400", GLASS)}
          >
            <Navigation2 className="h-5 w-5 fill-current" style={{ transform: `rotate(${-bearing}deg)` }} />
          </button>
        )}
      </div>

      {hint && (
        <div className="pointer-events-none absolute inset-x-0 top-1/3 z-20 flex justify-center px-6">
          <p className={cn("rounded-2xl px-4 py-3 text-center text-sm text-white", GLASS)}>
            Twist two fingers to turn the map. Drag two fingers up or down to tilt it.
          </p>
        </div>
      )}

      {/* Bottom: a message, then the card for the block you picked (or the location request) */}
      {!editing && (
      <div className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:pb-5",
        panelOpen && "md:pl-[456px] lg:pl-[496px]",
      )}>
        <div className="mx-auto w-full max-w-md">
          <div aria-live="polite" className="mb-2 flex justify-center">
            {toast && <p className={cn("max-w-full break-words rounded-2xl px-4 py-2 text-center text-sm text-white", GLASS)}>{toast}</p>}
          </div>

          {dest ? (
            <div className={cn("pointer-events-auto rounded-3xl p-3", GLASS)}>
              {arrived ? (
                <div className="flex items-center gap-3">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400"><Flag className="h-6 w-6" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-semibold text-white">You've arrived</p>
                    <p className="truncate text-sm text-zinc-400">{titleOf(dest)}{room ? `, room ${room}` : ""}</p>
                  </div>
                  <button type="button" onClick={() => { endNav(); onDestinationChange?.(null); }} className="h-10 rounded-full bg-sky-500 px-5 text-sm font-semibold text-white hover:bg-sky-400">Done</button>
                </div>
              ) : navigating && walk ? (
                <div>
                  <div className="flex items-center gap-3">
                    <BlockPlate num={dest.num} category={dest.category} size="lg" tone="solid" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-lg font-semibold leading-tight text-white">{titleOf(dest)}{room ? `, room ${room}` : ""}</p>
                      <p className="mt-1 text-sm text-zinc-400">
                        <span className="font-semibold text-sky-300">{minutes} min</span>
                        <span aria-hidden> · </span>
                        {formatDistance(metres ?? 0)} to go
                      </p>
                    </div>
                    <button type="button" aria-label="End navigation" title="End" onClick={endNav} className="flex h-10 w-10 shrink-0 items-center justify-center self-start rounded-full text-zinc-300 hover:bg-white/10 hover:text-white"><X className="h-5 w-5" /></button>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="How much of the walk is done" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                    <div className="h-full rounded-full bg-sky-400 transition-[width] duration-700 ease-out" style={{ width: `${Math.max(3, progress * 100)}%` }} />
                  </div>
                  {!follow && (
                    <button type="button" onClick={() => setFollow(true)} className="mt-3 h-10 w-full rounded-full bg-white/10 text-sm font-medium text-white hover:bg-white/15">Follow me again</button>
                  )}
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-3">
                    <BlockPlate num={dest.num} category={dest.category} size="lg" tone="solid" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-lg font-semibold leading-tight text-white">{dest.name}</p>
                      <p className="mt-1 truncate text-sm text-zinc-400">
                        {room && <span className="font-medium text-sky-300">Room {room}</span>}
                        {room && destLine ? ", " : ""}
                        {destLine}
                      </p>
                    </div>
                    <button type="button" aria-label="Close" title="Close" onClick={() => onDestinationChange?.(null)} className="flex h-10 w-10 shrink-0 items-center justify-center self-start rounded-full text-zinc-300 hover:bg-white/10 hover:text-white">
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="mt-3 flex gap-2">
                    {primary === "walk" && (
                      <button type="button" onClick={startNav} className="flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-sky-500 text-base font-semibold text-white transition-colors hover:bg-sky-400 active:bg-sky-600">
                        <Navigation className="h-[18px] w-[18px]" /> Start walking
                      </button>
                    )}
                    {primary === "location" && (
                      <button type="button" onClick={startLocation} className="h-12 flex-1 rounded-2xl bg-sky-500 text-sm font-semibold text-white hover:bg-sky-400">
                        Turn on location
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={share}
                      aria-label="Share a link to this place"
                      title="Share"
                      className={cn("flex h-12 items-center justify-center gap-2 rounded-2xl bg-white/10 text-sm font-semibold text-white transition-colors hover:bg-white/15", primary ? "w-12 shrink-0" : "flex-1")}
                    >
                      <Share2 className="h-[18px] w-[18px]" />
                      {!primary && "Share this place"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : askLocation ? (
            <div className={cn("pointer-events-auto flex items-start gap-3 rounded-3xl p-3.5", GLASS)}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-300"><LocateFixed className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white">{ask.title}</p>
                <p className="mt-0.5 text-sm text-zinc-400">{ask.body}</p>
                <button type="button" onClick={startLocation} className="mt-2.5 h-9 rounded-full bg-sky-500 px-4 text-sm font-semibold text-white hover:bg-sky-400">{ask.cta}</button>
              </div>
              <button type="button" aria-label="Close" onClick={() => setAskClosed(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

export default LiveCampusMap;
