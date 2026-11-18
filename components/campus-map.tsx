"use client";

import * as React from "react";
import type { Map as MLMap, Marker as MLMarker } from "maplibre-gl";
import { useCampus } from "@/components/campus-provider";
import { buildingAtPoint, campusBounds, CENTER, isGateName, isNamed, tagOf, type Block, type FC, type Feat, type Pt } from "@/lib/campus";
import { cn } from "@/lib/utils";

// Dark LPU campus map. Used twice: a small preview next to the block list, and the full live map.

export type CampusMapProps = {
  mode: "preview" | "live";
  activeNum?: string | null; // block to highlight and fly to
  user?: Pt | null; // the blue dot
  route?: Pt[] | null; // walking route from the user to the block
  threeD?: boolean;
  onMap?: (map: MLMap | null) => void;
  onPickBlock?: (num: string) => void;
  className?: string;
};

const EMPTY: FC = { type: "FeatureCollection", features: [] };
const BT_COLOR = ["match", ["get", "bt"], "academic", "#27476E", "hostel", "#4A3570", "food", "#7A5424", "sports", "#25613F", "#323C4D"];

/**
 * The picked building's outline, pushed out by `m` metres on every side. The blue copy then stands just
 * outside the grey building's walls instead of exactly on them, so the two never flicker against each
 * other (that flicker is what made the blue look dotted or faded on some sides).
 */
function grow(f: Feat, m: number): Feat {
  if (f.geometry.type !== "Polygon") return f;
  const ring = f.geometry.coordinates[0];
  const kx = 111320 * Math.cos((31.25 * Math.PI) / 180), ky = 110574;
  const pts = ring.map(([x, y]) => [x * kx, y * ky]);
  const closed = pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  const v = closed ? pts.slice(0, -1) : pts;
  if (v.length < 3) return f;
  let area = 0;
  for (let i = 0; i < v.length; i++) { const a = v[i], b = v[(i + 1) % v.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = area > 0 ? 1 : -1; // outward side depends on which way the outline runs
  const normal = (a: number[], b: number[]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [(sgn * dy) / L, (-sgn * dx) / L];
  };
  const out = v.map((p, i) => {
    const n1 = normal(v[(i - 1 + v.length) % v.length], p), n2 = normal(p, v[(i + 1) % v.length]);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const L = Math.hypot(mx, my);
    if (L < 1e-6) { mx = n2[0]; my = n2[1]; } else { mx /= L; my /= L; }
    const cos = Math.max(0.4, mx * n2[0] + my * n2[1]); // limit how far sharp corners stick out
    return [(p[0] + (mx * m) / cos) / kx, (p[1] + (my * m) / cos) / ky] as Pt;
  });
  out.push(out[0]);
  return { ...f, geometry: { type: "Polygon", coordinates: [out] } };
}

const SEL_H_3D = ["+", ["coalesce", ["get", "h"], 9], 1];
const ROUTE_ON = "#38BDF8", ROUTE_CASE = "#0C4A6E";
const drawn = (color: string, t: number) =>
  t >= 1 ? color : ["step", ["line-progress"], color, Math.max(0.0001, t), "rgba(0,0,0,0)"];

function addLayers(map: MLMap) {
  map.addSource("campus", { type: "geojson", data: EMPTY as never });
  map.addSource("sel", { type: "geojson", data: EMPTY as never });
  map.addSource("route", { type: "geojson", data: EMPTY as never, lineMetrics: true });
  map.addSource("route-end", { type: "geojson", data: EMPTY as never });
  const kind = (k: string) => ["==", ["get", "kind"], k] as never;
  map.addLayer({ id: "outline-fill", type: "fill", source: "campus", filter: kind("outline"), paint: { "fill-color": "#0F1318" } });
  map.addLayer({ id: "green", type: "fill", source: "campus", filter: kind("green"), paint: { "fill-color": "#0F2A1E" } });
  map.addLayer({
    id: "road", type: "line", source: "campus", filter: kind("road"),
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#26303C", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 19, 11] },
  });
  map.addLayer({
    id: "path", type: "line", source: "campus", filter: kind("path"),
    paint: { "line-color": "#556273", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.8, 19, 3], "line-dasharray": [2, 2] },
  });
  map.addLayer({ id: "outline-glow", type: "line", source: "campus", filter: kind("outline"), paint: { "line-color": "#0EA5E9", "line-width": 8, "line-blur": 8, "line-opacity": 0.55 } });
  map.addLayer({ id: "outline-line", type: "line", source: "campus", filter: kind("outline"), paint: { "line-color": "#38BDF8", "line-width": 2 } });
  map.addLayer({
    id: "building-3d", type: "fill-extrusion", source: "campus", filter: kind("building"),
    paint: { "fill-extrusion-color": BT_COLOR as never, "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.95 },
  });
  // The picked building: one solid, even blue (no darker band at the foot of the walls), a little taller
  // than the building and a hair wider, plus a bright line round its foot so it reads even when flat.
  map.addLayer({
    id: "sel-3d", type: "fill-extrusion", source: "sel",
    paint: {
      "fill-extrusion-color": "#38BDF8", "fill-extrusion-height": SEL_H_3D as never, "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 1, "fill-extrusion-vertical-gradient": false,
    },
  });
  map.addLayer({
    id: "sel-line", type: "line", source: "sel",
    layout: { "line-join": "round" },
    paint: { "line-color": "#BAE6FD", "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1.5, 19, 3.5] },
  });
  map.addLayer({
    id: "route-casing", type: "line", source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-gradient": ROUTE_CASE, "line-width": ["interpolate", ["linear"], ["zoom"], 15, 7, 19, 13], "line-opacity": 0.9 } as never,
  });
  map.addLayer({
    id: "route-line", type: "line", source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-gradient": ROUTE_ON, "line-width": ["interpolate", ["linear"], ["zoom"], 15, 4, 19, 8] } as never,
  });
  map.addLayer({
    id: "route-end", type: "circle", source: "route-end",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 4, 19, 8], "circle-color": "#FFFFFF", "circle-stroke-color": ROUTE_ON, "circle-stroke-width": 3 },
  });
}

/**
 * Hide labels that would sit on top of one already shown. The picked block always stays, then named places
 * (Unimall, the main gate), then building names, then numbers (lower numbers first).
 */
function declutter(markers: MLMarker[]) {
  const items = markers.map((m) => {
    const el = m.getElement();
    el.classList.remove("hide");
    const t = el.textContent || "";
    const isNum = /^\d{1,3}[A-Z]?$/.test(t);
    const k = el.classList.contains("is-active") ? -1
      : el.classList.contains("campus-place") ? 0
        : isNum ? 2000 + (parseInt(t, 10) || 0) : 1000;
    return { el, k };
  }).sort((a, b) => a.k - b.k);
  const kept: DOMRect[] = [];
  items.forEach((it) => {
    const r = it.el.getBoundingClientRect();
    if (!r.width) return;
    for (const k of kept) {
      if (r.left < k.right + 2 && r.right > k.left - 2 && r.top < k.bottom + 1 && r.bottom > k.top - 1) {
        it.el.classList.add("hide");
        return;
      }
    }
    kept.push(r);
  });
}

/** Classes for a named place's label: its kind (park, food) colours it, and "Main gate" looks like the gate. */
function placeClass(b: Block | undefined): string {
  if (!b) return " campus-name campus-place";
  return " campus-name campus-place"
    + (b.category === "park" ? " campus-park" : b.category === "food" ? " campus-food" : "")
    + (isGateName(b.name) ? " campus-gate" : "");
}

/** The label of the picked block stands out (and always shows); every other label goes back to normal. */
function markActive(markers: MLMarker[], num: string | null) {
  markers.forEach((m) => {
    const el = m.getElement();
    el.classList.toggle("is-active", !!num && el.dataset.num === num);
  });
}

/** Height in metres each marker should float at in 3D (its building's roof). */
const roofOf = new WeakMap<MLMarker, number>();

/**
 * In 3D, lift every number from the ground up to the roof of its own building, so connected
 * buildings each show their number on top of the right block instead of behind a wall.
 */
function liftToRoofs(map: MLMap, markers: MLMarker[], on: boolean) {
  const pitch = (map.getPitch() * Math.PI) / 180;
  const brg = (map.getBearing() * Math.PI) / 180;
  const up = on ? Math.sin(pitch) : 0;
  markers.forEach((m) => {
    const h = roofOf.get(m) || 0;
    if (!h || !up) { m.setOffset([0, 0]); return; }
    const ll = m.getLngLat();
    // Screen pixels per metre at this spot: measure 10 m along the screen's left-right direction.
    const d = 10;
    const kx = 111320 * Math.cos((ll.lat * Math.PI) / 180);
    const p0 = map.project(ll);
    const p1 = map.project([ll.lng + (d * Math.cos(brg)) / kx, ll.lat - (d * Math.sin(brg)) / 110574] as never);
    const ppm = Math.hypot(p1.x - p0.x, p1.y - p0.y) / d;
    m.setOffset([0, -(h + 1.5) * ppm * up]);
  });
}

export function CampusMap({ mode, activeNum, user, route, threeD = true, onMap, onPickBlock, className }: CampusMapProps) {
  const ctx = useCampus();
  const { fc, blocks, labels, error } = ctx;
  const ctxRef = React.useRef(ctx); // latest values, for the map's click handler
  ctxRef.current = ctx;
  const box = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<MLMap | null>(null);
  const libRef = React.useRef<any>(null); // maplibre-gl module, loaded in the browser only
  const numMarkers = React.useRef<MLMarker[]>([]);
  const textMarkers = React.useRef<MLMarker[]>([]);
  const userMarker = React.useRef<MLMarker | null>(null);
  const fitted = React.useRef(false);
  const threeDRef = React.useRef(threeD);
  threeDRef.current = threeD;
  const activeRef = React.useRef<string | null>(activeNum ?? null);
  activeRef.current = activeNum ?? null;
  const spotMarker = React.useRef<MLMarker | null>(null);
  const { editing, editSpot } = ctx;
  const [ready, setReady] = React.useState(false);
  const onPickRef = React.useRef(onPickBlock);
  onPickRef.current = onPickBlock;
  const onMapRef = React.useRef(onMap);
  onMapRef.current = onMap;

  // Create the map once.
  React.useEffect(() => {
    let cancelled = false;
    let map: MLMap | null = null;
    (async () => {
      const ml = (await import("maplibre-gl")).default as any;
      if (cancelled || !box.current) return;
      libRef.current = ml;
      map = new ml.Map({
        container: box.current,
        center: CENTER,
        zoom: 15.3,
        pitch: threeD ? 45 : 0,
        maxZoom: 20,
        maxPitch: 75,
        attributionControl: false,
        bearingSnap: 0, // never snap back to north while turning, so it rotates freely through 360 degrees
        dragRotate: true, // computer: right-click drag, or Ctrl + drag
        touchZoomRotate: true, // phone: twist with two fingers
        touchPitch: true, // phone: drag two fingers up or down to tilt
        pitchWithRotate: true,
        cooperativeGestures: mode === "preview", // on the preview, one finger scrolls the page
        style: { version: 8, sources: {}, layers: [{ id: "ground", type: "background", paint: { "background-color": "rgba(9,9,11,0.35)" } }] },
      }) as MLMap;
      const m = map;
      m.dragRotate.enable();
      m.touchZoomRotate.enable({ around: "center" });
      m.touchZoomRotate.enableRotation();
      m.touchPitch.enable();
      const zoomClass = () => {
        const z = m.getZoom();
        const el = box.current;
        if (!el) return;
        el.classList.toggle("map-zoomed", z >= 15.9);
        el.classList.toggle("map-z15", z >= 15.2);
        el.classList.toggle("map-z13", z >= 13);
      };
      const tidy = () => declutter([...numMarkers.current, ...textMarkers.current]);
      let liftFrame = 0;
      const lift = () => {
        if (liftFrame) return;
        liftFrame = requestAnimationFrame(() => { liftFrame = 0; liftToRoofs(m, numMarkers.current, threeDRef.current); });
      };
      m.on("move", lift);
      m.on("zoom", zoomClass);
      m.on("moveend", tidy);
      m.on("rotateend", tidy);
      if (mode === "live") {
        // Owner editing: a tap tells the editor which building or spot to work on.
        m.on("click", (e: any) => {
          const s = ctxRef.current;
          if (s.editing) s.onEditTap([e.lngLat.lng, e.lngLat.lat]);
        });
      }
      m.on("load", () => {
        addLayers(m);
        mapRef.current = m;
        zoomClass();
        setReady(true);
        onMapRef.current?.(m);
      });
    })();
    return () => {
      cancelled = true;
      onMapRef.current?.(null);
      numMarkers.current.forEach((x) => x.remove());
      textMarkers.current.forEach((x) => x.remove());
      userMarker.current?.remove();
      spotMarker.current?.remove();
      numMarkers.current = []; textMarkers.current = []; userMarker.current = null; spotMarker.current = null;
      map?.remove();
      mapRef.current = null;
      fitted.current = false;
      setReady(false);
    };
  }, [mode]);

  // Campus data, and a number on each building.
  React.useEffect(() => {
    const map = mapRef.current, ml = libRef.current;
    if (!ready || !map || !ml || !fc) return;
    (map.getSource("campus") as any).setData(fc);

    if (!fitted.current) {
      const b = campusBounds(fc);
      if (b) {
        map.fitBounds(b as never, {
          padding: mode === "preview" ? 30 : { top: 110, bottom: 150, left: 24, right: 24 },
          pitch: threeD ? 45 : 0, duration: 0,
        });
        fitted.current = true;
      }
    }

    numMarkers.current.forEach((x) => x.remove());
    numMarkers.current = [];
    const info = new Map(blocks.map((b) => [b.num, b]));
    // A label tap picks the place; while the owner edits, it selects that spot in the editor instead.
    const onTap = (el: HTMLElement, num: string | undefined, at: Pt) => {
      el.style.cursor = "pointer";
      el.addEventListener("click", (ev) => {
        const s = ctxRef.current;
        if (s.editing) { ev.stopPropagation(); s.onEditTap(at); return; }
        if (num) onPickRef.current?.(num);
      });
    };
    fc.features.forEach((f) => {
      const p = f.properties;
      if (p.kind !== "building") return;
      // Every saved label on a building gets its own spot (a connected complex can carry several).
      if (p.marks && p.marks.length) {
        p.marks.forEach((m) => {
          if (m.hidden && !editing) return; // hidden labels show only in the owner's editor
          const b = info.get(m.num);
          const el = document.createElement("div");
          el.className = "campus-num" + (isNamed(m.num) ? placeClass(b) : "") + (m.hidden ? " is-hidden" : "");
          el.textContent = isNamed(m.num) ? (b ? b.name : tagOf(m.num)) : m.num;
          el.dataset.num = m.num;
          onTap(el, m.num, m.c);
          const mk = new ml.Marker({ element: el }).setLngLat(m.c).addTo(map);
          roofOf.set(mk, Number(p.h) || 9);
          numMarkers.current.push(mk);
        });
        return;
      }
      // A label from OpenStreetMap (a number or a building name).
      if (!p.label || !p.c) return;
      const el = document.createElement("div");
      const isNum = /^\d{1,3}[A-Z]?$/.test(p.label);
      el.className = "campus-num" + (isNum ? "" : " campus-name");
      el.textContent = p.label;
      if (p.num) el.dataset.num = p.num;
      onTap(el, p.num || undefined, p.c);
      const mk = new ml.Marker({ element: el }).setLngLat(p.c).addTo(map);
      roofOf.set(mk, Number(p.h) || 9);
      numMarkers.current.push(mk);
    });
    // Saved labels on open ground (a park, a food court in the open): no building shape there.
    blocks.forEach((b) => {
      if (!b.c || b.feature) return;
      if (b.hidden && !editing) return;
      const el = document.createElement("div");
      el.className = "campus-num" + (isNamed(b.num) ? placeClass(b) : "") + (b.hidden ? " is-hidden" : "");
      el.textContent = isNamed(b.num) ? b.name : b.num;
      el.dataset.num = b.num;
      onTap(el, b.num, b.c);
      numMarkers.current.push(new ml.Marker({ element: el }).setLngLat(b.c).addTo(map));
    });

    textMarkers.current.forEach((x) => x.remove());
    textMarkers.current = [];
    labels.forEach((l) => {
      const el = document.createElement("div");
      el.className = "campus-text s" + (l.size || 2);
      el.textContent = l.text;
      textMarkers.current.push(new ml.Marker({ element: el }).setLngLat([l.lng, l.lat]).addTo(map));
    });
    markActive(numMarkers.current, activeRef.current);
    liftToRoofs(map, numMarkers.current, threeDRef.current);
    requestAnimationFrame(() => declutter([...numMarkers.current, ...textMarkers.current]));
  }, [ready, fc, blocks, labels, mode, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight the active block and fly to it.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (editing) return; // while the owner edits, the highlight shows the building being edited
    const b = activeNum ? blocks.find((x) => x.num === activeNum) : null;
    (map.getSource("sel") as any).setData(b && b.feature ? { type: "FeatureCollection", features: [grow(b.feature, 0.4)] } : EMPTY);
    markActive(numMarkers.current, activeNum ?? null);
    requestAnimationFrame(() => declutter([...numMarkers.current, ...textMarkers.current]));
    if (b && b.c) {
      map.flyTo({ center: b.c, zoom: mode === "preview" ? 17.2 : 17.6, pitch: threeD ? 55 : 0, duration: 1200, essential: true });
    }
  }, [ready, activeNum, blocks, mode, threeD, editing]);

  // Owner editing: light up the building that was tapped, with a ring on the exact spot.
  React.useEffect(() => {
    const map = mapRef.current, ml = libRef.current;
    if (!ready || !map || !ml) return;
    const spot = editing ? editSpot : null;
    if (editing) {
      const f = spot && fc ? buildingAtPoint(fc, spot.at) : null;
      (map.getSource("sel") as any).setData(f ? { type: "FeatureCollection", features: [grow(f, 0.4)] } : EMPTY);
    }
    if (!spot) { spotMarker.current?.remove(); spotMarker.current = null; return; }
    if (!spotMarker.current) {
      const el = document.createElement("div");
      el.className = "edit-spot";
      spotMarker.current = new ml.Marker({ element: el }).setLngLat(spot.at).addTo(map);
    } else {
      spotMarker.current.setLngLat(spot.at);
    }
  }, [ready, editing, editSpot, fc]);

  // 3D on or off.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setPaintProperty("building-3d", "fill-extrusion-height", threeD ? ["get", "h"] : 0.3);
    map.setPaintProperty("sel-3d", "fill-extrusion-height", threeD ? SEL_H_3D : 0.6);
    // The bright ring round the picked building's foot is for the flat view; in 3D it would show through the walls.
    map.setLayoutProperty("sel-line", "visibility", threeD ? "none" : "visible");
    box.current?.classList.toggle("map-3d", threeD);
    liftToRoofs(map, numMarkers.current, threeD);
    // Tilt only if the map is not already tilted the right way (the opening view sets its own tilt).
    const pitch = map.getPitch();
    if (!map.isMoving() && (threeD ? pitch < 20 : pitch > 0)) map.easeTo({ pitch: threeD ? 45 : 0, duration: 500 });
    requestAnimationFrame(() => declutter([...numMarkers.current, ...textMarkers.current]));
  }, [ready, threeD]);

  // Line from the user to the destination. A new walk draws itself in from the blue dot; while walking,
  // the line just shortens behind the student.
  const drawnFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const ok = !!route && route.length > 1;
    (map.getSource("route") as any).setData(
      ok ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route } }] } : EMPTY,
    );
    (map.getSource("route-end") as any).setData(
      ok ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: route![route!.length - 1] } }] } : EMPTY,
    );
    if (!ok) { drawnFor.current = null; return; }
    const forWhat = activeRef.current;
    if (drawnFor.current === forWhat) return;
    drawnFor.current = forWhat;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const t0 = performance.now(), ms = reduce ? 0 : 700;
    const step = () => {
      const t = ms ? Math.min(1, (performance.now() - t0) / ms) : 1;
      const e = 1 - Math.pow(1 - t, 3); // eases out
      try {
        map.setPaintProperty("route-line", "line-gradient", drawn(ROUTE_ON, e) as never);
        map.setPaintProperty("route-casing", "line-gradient", drawn(ROUTE_CASE, e) as never);
      } catch { return; }
      if (t < 1) raf = requestAnimationFrame(step);
    };
    step();
    return () => {
      cancelAnimationFrame(raf);
      try {
        map.setPaintProperty("route-line", "line-gradient", ROUTE_ON as never);
        map.setPaintProperty("route-casing", "line-gradient", ROUTE_CASE as never);
      } catch { /* map gone */ }
    };
  }, [ready, route]);

  // The blue dot.
  React.useEffect(() => {
    const map = mapRef.current, ml = libRef.current;
    if (!ready || !map || !ml) return;
    if (!user) { userMarker.current?.remove(); userMarker.current = null; return; }
    if (!userMarker.current) {
      const el = document.createElement("div");
      el.className = "user-dot";
      el.innerHTML = "<span></span>";
      userMarker.current = new ml.Marker({ element: el }).setLngLat(user).addTo(map);
    } else {
      userMarker.current.setLngLat(user);
    }
  }, [ready, user]);

  return (
    <div className={cn("relative h-full w-full overflow-hidden", className)}>
      <div ref={box} className="absolute inset-0" />
      {!fc && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative h-12 w-12">
            <div className="absolute inset-0 animate-ping rounded-full bg-sky-400/30" />
            <div className="absolute inset-2 animate-pulse rounded-full bg-sky-500/50" />
          </div>
        </div>
      )}
      {error && <div className="absolute inset-x-4 top-4 rounded-xl bg-zinc-900/90 p-3 text-sm text-zinc-200">{error}</div>}
    </div>
  );
}
