// Campus data for LPU Wayfinder: loading from OpenStreetMap, giving block numbers to buildings, and searching.
// Ported from the single-file index.html version.

export type Pt = [number, number]; // [longitude, latitude]

/** One block number on a building, and the spot where its label goes. A connected complex can carry several. */
export type Mark = { num: string; c: Pt; cell?: Pt[]; hidden?: boolean }; // cell: this number's part of a shared outline

export type FeatureProps = {
  kind: "outline" | "building" | "road" | "path" | "green";
  label?: string; // text drawn on the map
  marks?: Mark[]; // every block number on this building, each with its own spot
  num?: string; // block number
  nm?: string; // building name (from OpenStreetMap or "Main gate")
  bt?: string; // category, for colour
  h?: number; // height in metres
  c?: Pt; // centre
  c0?: Pt; // original centre
  gate?: boolean;
};

export type Feat = {
  type: "Feature";
  properties: FeatureProps;
  geometry: { type: "Polygon"; coordinates: Pt[][] } | { type: "LineString"; coordinates: Pt[] };
};

export type FC = { type: "FeatureCollection"; features: Feat[] };

export type DbBlock = {
  block_no: string;
  name: string;
  category: string | null;
  aliases: string[] | null;
  lng: number | null;
  lat: number | null;
  hidden?: boolean | null; // the owner hid it: students don't see it
};

export type DbLabel = { key: string; text: string; lng: number; lat: number; size: number | null };

export type Block = {
  num: string;
  name: string; // shown name
  dept: string; // departments from the isometric map legend
  category: string;
  aliases: string[];
  c: Pt | null; // where it is on the map, if placed
  placed: boolean;
  feature?: Feat;
  hidden: boolean; // hidden by the owner (only listed while the owner edits)
};

// ---------- constants ----------
export const REL = 21599790; // OpenStreetMap relation for the LPU campus
export const CENTER: Pt = [75.70807, 31.25148];
const CACHE_KEY = "lpuCampusNextV1";

// Main gate [lng, lat]. Leave null to use the place the owner names "Main gate" on the map.
export const GATE: Pt | null = null;

// What each block holds, from the LPU isometric map legend. Only used until the database has loaded.
export const DEPTS: Record<string, string> = {
  "1": "Fashion", "2": "Baldev Raj Auditorium", "3": "Physiotherapy", "4": "Pharmacy", "6": "Architecture", "7": "Pharmacy",
  "8": "Animation, Fine Arts", "13": "Student Welfare Wing", "18": "Education", "19": "Performing Arts",
  "20": "Film and Journalism, Law", "25": "Agriculture", "26": "Agriculture", "27": "Physical Science", "28": "Biotechnology",
  "29": "Administrative", "30": "Pro-Chancellor", "31": "Chancellor, Administrative", "32": "Admission", "33": "Computer Application",
  "34": "Computer Science", "35": "Shantidevi Auditorium", "36": "Electronics and Telecom", "37": "Research", "38": "Civil",
  "47": "Indoor stadium", "56": "Mechanical", "57": "Polytechnic", "58": "Project Lab",
};

// ---------- geometry helpers ----------
const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];

function stitch(segs: Pt[][]): Pt[][] {
  const rings: Pt[][] = [];
  const pool = segs.map((s) => s.slice());
  while (pool.length) {
    let cur = pool.shift() as Pt[];
    let guard = 0;
    while (!same(cur[0], cur[cur.length - 1]) && guard++ < 5000) {
      let found = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (same(cur[cur.length - 1], s[0])) { cur = cur.concat(s.slice(1)); pool.splice(i, 1); found = true; break; }
        if (same(cur[cur.length - 1], s[s.length - 1])) { cur = cur.concat(s.slice(0, -1).reverse()); pool.splice(i, 1); found = true; break; }
      }
      if (!found) break;
    }
    if (cur.length > 3) {
      if (!same(cur[0], cur[cur.length - 1])) cur.push(cur[0]);
      rings.push(cur);
    }
  }
  return rings;
}

export function pointInRing(pt: Pt, ring: Pt[]): boolean {
  const [x, y] = pt;
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function centroid(coords: Pt[]): Pt {
  let x = 0, y = 0;
  const n = coords.length - 1 || 1;
  for (let i = 0; i < n; i++) { x += coords[i][0]; y += coords[i][1]; }
  return [x / n, y / n];
}

function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
}

export function insideCampus(fc: FC, pt: Pt): boolean {
  return fc.features.some((f) => f.properties.kind === "outline" && f.geometry.type === "Polygon" && pointInRing(pt, f.geometry.coordinates[0]));
}

export function campusBounds(fc: FC): [Pt, Pt] | null {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90, any = false;
  fc.features.forEach((f) => {
    if (f.properties.kind !== "outline" || f.geometry.type !== "Polygon") return;
    f.geometry.coordinates[0].forEach(([x, y]) => { any = true; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
  });
  return any ? [[x0, y0], [x1, y1]] : null;
}

export function distanceMetres(a: Pt, b: Pt): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- loading the campus from OpenStreetMap ----------
const PATHS: Record<string, 1> = { footway: 1, path: 1, pedestrian: 1, steps: 1, track: 1, cycleway: 1, bridleway: 1 };

type OsmEl = {
  type: string; id: number; tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
};

function buildCollection(elements: OsmEl[]): FC {
  const feats: Feat[] = [];
  const segs: Pt[][] = [];
  elements.forEach((el) => {
    if (el.type === "relation" && el.id === REL) {
      (el.members || []).forEach((m) => {
        if (m.type === "way" && m.geometry && (m.role === "outer" || m.role === "")) segs.push(m.geometry.map((p) => [p.lon, p.lat] as Pt));
      });
    }
  });
  const rings = stitch(segs);
  if (!rings.length) throw new Error("Campus outline was not found in the data.");
  rings.forEach((r) => feats.push({ type: "Feature", properties: { kind: "outline" }, geometry: { type: "Polygon", coordinates: [r] } }));
  const inside = (p: Pt) => rings.some((r) => pointInRing(p, r));

  elements.forEach((el) => {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) return;
    const t = el.tags || {};
    const pts = el.geometry.map((p) => [p.lon, p.lat] as Pt);
    const closed = same(pts[0], pts[pts.length - 1]) && pts.length > 3;
    if (t.building && closed) {
      const c = centroid(pts);
      if (!inside(c)) return;
      let num = "", nm = "";
      [t.ref, t.name, t["addr:housename"], t["building:name"]].forEach((s0) => {
        if (!s0) return;
        const s = String(s0);
        const m = s.match(/^(?:block|blk)?\s*-?\s*(\d{1,3}[A-Za-z]?)$/i) || s.match(/(?:block|blk)\s*-?\s*(\d{1,3}[A-Za-z]?)/i);
        if (m) {
          if (!num) {
            num = m[1].toUpperCase();
            const rest = s.replace(m[0], "").replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, "");
            if (rest && !nm) nm = rest;
          }
        } else if (!nm) nm = s;
      });
      const bld = String(t.building || ""), am = String(t.amenity || "");
      let bt = "other";
      if (/dormitory|residential|apartments|hostel/.test(bld) || am === "dormitory") bt = "hostel";
      else if (/commercial|retail|supermarket|kiosk/.test(bld) || /restaurant|cafe|fast_food|food_court|marketplace/.test(am) || t.shop) bt = "food";
      else if (/sports|stadium|gym/.test(bld) || t.leisure) bt = "sports";
      else if (/university|college|school|civic|public|office|library/.test(bld) || /university|college|school|library/.test(am)) bt = "academic";
      let h = parseFloat(t.height);
      if (!(h > 0)) { const lv = parseFloat(t["building:levels"]); h = lv > 0 ? lv * 3.2 : 9; }
      h = Math.max(5, Math.min(h, 45));
      feats.push({ type: "Feature", properties: { kind: "building", label: num ? num : nm, num, nm, bt, h, c, c0: c }, geometry: { type: "Polygon", coordinates: [pts] } });
    } else if (t.highway) {
      const kind = PATHS[t.highway] ? "path" : "road";
      let run: Pt[] = [];
      const flush = () => {
        if (run.length > 1) feats.push({ type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates: run } });
        run = [];
      };
      pts.forEach((p) => { if (inside(p)) run.push(p); else flush(); });
      flush();
    } else if ((t.leisure || t.landuse) && closed) {
      if (inside(centroid(pts))) feats.push({ type: "Feature", properties: { kind: "green" }, geometry: { type: "Polygon", coordinates: [pts] } });
    }
  });
  return { type: "FeatureCollection", features: feats };
}

/** A saved copy of the campus data that ships with the site (public/campus-raw.json). Fast, and needs no outside server. */
async function loadSnapshot(): Promise<FC | null> {
  try {
    const r = await fetch("/campus-raw.json");
    if (!r.ok) return null;
    const d = (await r.json()) as { elements?: OsmEl[] };
    return Array.isArray(d.elements) ? buildCollection(d.elements) : null;
  } catch {
    return null;
  }
}

/** The site's own server fetches OpenStreetMap once a day and shares it (app/api/campus). */
let serverError = "";
async function loadFromServer(): Promise<FC | null> {
  try {
    const r = await fetch("/api/campus");
    if (!r.ok) {
      let m = "HTTP " + r.status;
      try { m = ((await r.json()) as { error?: string }).error || m; } catch { /* ignore */ }
      serverError = m;
      return null;
    }
    const d = (await r.json()) as { elements?: OsmEl[] };
    return Array.isArray(d.elements) ? buildCollection(d.elements) : null;
  } catch {
    return null;
  }
}

/** Loads the campus buildings, roads and outline: the copy shipped with the site, else the one saved in this browser, else the site's server. */
export async function loadCampus(): Promise<FC> {
  const snap = await loadSnapshot();
  if (snap) return snap;
  try {
    const c = localStorage.getItem(CACHE_KEY);
    if (c) return JSON.parse(c) as FC;
  } catch { /* no saved copy */ }
  const viaServer = await loadFromServer();
  if (!viaServer) throw new Error("site server: " + (serverError || "no data"));
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(viaServer)); } catch { /* storage full or blocked */ }
  return viaServer;
}

// ---------- putting the saved labels on buildings ----------
/** The smallest building whose outline contains the point. */
export function buildingAt(blds: Feat[], pt: Pt): Feat | null {
  let best: Feat | null = null, ba = 1e9;
  blds.forEach((f) => {
    if (f.geometry.type !== "Polygon") return;
    if (pointInRing(pt, f.geometry.coordinates[0])) {
      const a = ringArea(f.geometry.coordinates[0]);
      if (a < ba) { ba = a; best = f; }
    }
  });
  return best;
}

/** The building under a point on the map, if there is one. */
export function buildingAtPoint(fc: FC, pt: Pt): Feat | null {
  return buildingAt(fc.features.filter((f) => f.properties.kind === "building"), pt);
}

/** The place the owner names "Main gate": the map opens there for people outside the campus. */
export const isGateName = (name: string) => /^main gate$/i.test(name.trim());

/**
 * The part of an outline nearest to one spot, when several numbers share the outline. The outline is cut along the
 * midlines between this spot and each other spot, so the parts of all the numbers fit together without overlapping.
 */
function cellOf(ring: Pt[], spot: Pt, others: Pt[]): Pt[] {
  let poly = ring.slice(0, -1); // drop the closing point
  others.forEach((o) => {
    const mx = (spot[0] + o[0]) / 2, my = (spot[1] + o[1]) / 2;
    const nx = spot[0] - o[0], ny = spot[1] - o[1];
    const side = (p: Pt) => (p[0] - mx) * nx + (p[1] - my) * ny; // 0 on the midline, positive on this spot's side
    const out: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const sa = side(a), sb = side(b);
      if (sa >= 0) out.push(a);
      if ((sa >= 0) !== (sb >= 0)) {
        const t = sa / (sa - sb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = out;
  });
  return poly.length >= 3 ? [...poly, poly[0]] : ring;
}

/**
 * Puts the saved labels on buildings. Every label comes from the database (placed by the owner) or from OpenStreetMap;
 * nothing is guessed. A database label inside a building takes the building over, so its OpenStreetMap label no
 * longer shows. Hidden labels still hold their building but are marked hidden (only the owner's editor draws them).
 * Labels on open ground (a park, say) are not on any building; the map draws them by themselves.
 * Returns a new collection (the input is not changed).
 */
export function placeBlocks(input: FC, db: DbBlock[]): FC {
  const fc: FC = JSON.parse(JSON.stringify(input));
  const blds = fc.features.filter((f) => f.properties.kind === "building" && f.properties.c);
  blds.forEach((f) => { if (!f.properties.c0) f.properties.c0 = f.properties.c!.slice() as Pt; });
  // An OpenStreetMap number that the database also has is decided by the database (placed, moved or hidden).
  const saved = new Set(db.map((r) => r.block_no.toUpperCase()));
  blds.forEach((f) => {
    const p = f.properties;
    if (p.num && saved.has(p.num)) { p.num = ""; p.label = p.nm || ""; }
  });
  db.forEach((r) => {
    if (typeof r.lng !== "number" || typeof r.lat !== "number") return;
    const f = buildingAt(blds, [r.lng, r.lat]);
    if (!f) return;
    const p = f.properties;
    p.marks = [...(p.marks || []), { num: r.block_no.toUpperCase(), c: [r.lng, r.lat], hidden: !!r.hidden }];
    if (!r.hidden && isGateName(r.name)) p.gate = true;
  });
  blds.forEach((f) => {
    const p = f.properties;
    if (!p.marks || !p.marks.length) return;
    p.marks.sort((a, b) => numCmp(a.num, b.num));
    const shown = p.marks.filter((m) => !m.hidden);
    // Each numbered building also keeps one main number, for code that reads a single number.
    // A building with only hidden labels shows nothing, not even its OpenStreetMap name.
    p.num = shown.length ? shown[0].num : "";
    p.label = shown.map((m) => tagOf(m.num)).join(" · ");
    // Each number on a shared outline gets its own part, so selecting it lights up only its building.
    if (shown.length >= 2) {
      const ring = (f.geometry as { coordinates: Pt[][] }).coordinates[0];
      shown.forEach((m) => { m.cell = cellOf(ring, m.c, shown.filter((o) => o !== m).map((o) => o.c)); });
    }
  });
  return fc;
}

// ---------- the block list ----------
/** A named place without a block number, e.g. UNIPOLIS. */
export const isNamed = (num: string) => !/^\d/.test(num);

/** What to write on the map for a block id: the number, or a tidy name for a named place ("UNIPOLIS" -> "Unipolis"). */
export const tagOf = (num: string) =>
  isNamed(num) ? num.toLowerCase().replace(/(^|[-\s])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase()) : num;

/** "Block 34", or just the name for a named place. */
export const titleOf = (b: { num: string; name: string }) => (isNamed(b.num) ? b.name : "Block " + b.num);

export function numCmp(a: string, b: string): number {
  if (isNamed(a) !== isNamed(b)) return isNamed(a) ? 1 : -1;
  return (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b);
}

export function buildBlocks(fc: FC, db: DbBlock[]): Block[] {
  // Where each number is drawn: its own spot (marks) on a building, or the building's centre for a single number.
  const byNum: Record<string, { f: Feat; c: Pt }> = {};
  fc.features.forEach((f) => {
    const p = f.properties;
    if (p.kind !== "building") return;
    if (p.marks && p.marks.length) p.marks.forEach((m) => {
      const part: Feat = m.cell ? { type: "Feature", properties: p, geometry: { type: "Polygon", coordinates: [m.cell] } } : f;
      byNum[m.num] = { f: part, c: m.c };
    });
    else if (p.num && p.c) byNum[p.num] = { f, c: p.c };
  });
  const rows: Record<string, DbBlock> = {};
  db.forEach((r) => { rows[r.block_no.toUpperCase()] = r; });
  // The database decides which places exist. The old legend only fills in until the database has loaded.
  const nums = (db.length ? Object.keys(rows) : Object.keys(DEPTS)).sort(numCmp);
  return nums.map((n) => {
    const r = rows[n], hit = byNum[n];
    const dbPos: Pt | null = r && typeof r.lng === "number" && typeof r.lat === "number" ? [r.lng, r.lat] : null;
    const c = dbPos || (hit ? hit.c : null);
    return {
      num: n,
      name: (r && r.name) || DEPTS[n] || "Block " + n,
      dept: r ? "" : DEPTS[n] || "",
      category: (r && r.category) || "other",
      aliases: (r && r.aliases) || [],
      c,
      placed: !!c,
      feature: hit ? hit.f : undefined,
      hidden: !!(r && r.hidden),
    };
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Search by block number, name, department or alias. Number matches come first. */
export function searchBlocks(blocks: Block[], query: string): Block[] {
  const q = norm(query.replace(/^block\s*/i, ""));
  if (!q) return blocks;
  const scored: [number, Block][] = [];
  blocks.forEach((b) => {
    const num = norm(b.num);
    const text = norm([b.name, b.dept, b.aliases.join(" "), "block " + b.num].join(" "));
    let s = -1;
    if (num === q) s = 0;
    else if (num.startsWith(q) && /^\d/.test(q)) s = 1;
    else if (text.startsWith(q)) s = 2;
    else if (text.split(" ").some((w) => w.startsWith(q))) s = 3;
    else if (text.includes(q)) s = 4;
    if (s >= 0) scored.push([s, b]);
  });
  return scored.sort((a, b) => a[0] - b[0] || numCmp(a[1].num, b[1].num)).map((x) => x[1]);
}
