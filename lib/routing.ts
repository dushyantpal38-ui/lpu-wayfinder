import type { FC, Pt } from "@/lib/campus";

// Walking routes on campus.
// The roads and footpaths from OpenStreetMap become a graph (junctions are nodes, stretches are edges).
// On top of that, students cut across open ground, so short straight links between nearby path points
// are added wherever the straight line does not pass through a building. The cheapest way from the
// student to the nearest side of the building is found with Dijkstra, then straightened so the line
// on the map has as few bends as possible.

const LAT0 = 31.25; // campus latitude, for converting degrees to metres
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110574;

type XY = [number, number];
const toXY = (p: Pt): XY => [p[0] * KX, p[1] * KY];
const toPt = (q: XY): Pt => [q[0] / KX, q[1] / KY];
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Walking across open ground (a lawn, a plaza) counts a little longer than walking on a path, so the
// route only leaves the paths when that is clearly shorter.
const OPEN = 1.25;
const SHORTCUT_M = 40; // longest straight link added between two path points
const REACH_M = 60; // how far the start or a building's side may be from the paths and still link to them directly
const CELL = 50; // grid size (metres) for finding nearby things fast

type Edge = { to: number; w: number };
type Bld = { ring: XY[]; x0: number; y0: number; x1: number; y1: number };

export type Graph = {
  pts: Pt[]; // node coordinates
  xy: XY[];
  adj: Edge[][];
  segs: { a: number; b: number }[]; // every road stretch, used to snap a point onto the network
  blds: Bld[];
  bGrid: Map<string, number[]>; // grid cell -> buildings touching it
  nGrid: Map<string, number[]>; // grid cell -> nodes in it
  sGrid: Map<string, number[]>; // grid cell -> road stretches touching it
};

const key = (p: Pt) => p[0].toFixed(7) + "," + p[1].toFixed(7);
const cellKey = (cx: number, cy: number) => cx + ":" + cy;

function gridAddBox(grid: Map<string, number[]>, i: number, x0: number, y0: number, x1: number, y1: number) {
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
    for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
      const k = cellKey(cx, cy);
      const l = grid.get(k);
      if (l) l.push(i); else grid.set(k, [i]);
    }
  }
}

function gridQuery(grid: Map<string, number[]>, x0: number, y0: number, x1: number, y1: number): number[] {
  const out = new Set<number>();
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
    for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
      grid.get(cellKey(cx, cy))?.forEach((i) => out.add(i));
    }
  }
  return [...out];
}

function inRing(q: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > q[1]) !== (yj > q[1]) && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function cross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when the straight line a-b does not go through any building (except the one numbered `skip`). */
function clear(g: Graph, a: XY, b: XY, skip = -1): boolean {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const mid: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (const i of gridQuery(g.bGrid, x0, y0, x1, y1)) {
    if (i === skip) continue;
    const B = g.blds[i];
    if (B.x1 < x0 || B.x0 > x1 || B.y1 < y0 || B.y0 > y1) continue;
    const r = B.ring;
    for (let k = 0, j = r.length - 1; k < r.length; j = k++) if (cross(a, b, r[j], r[k])) return false;
    if (inRing(mid, r)) return false;
  }
  return true;
}

/** The building (index) that contains a point, if any. */
function buildingIndexAt(g: Graph, q: XY): number {
  for (const i of gridQuery(g.bGrid, q[0], q[1], q[0], q[1])) {
    const B = g.blds[i];
    if (q[0] >= B.x0 && q[0] <= B.x1 && q[1] >= B.y0 && q[1] <= B.y1 && inRing(q, B.ring)) return i;
  }
  return -1;
}

export function buildGraph(fc: FC): Graph {
  const ids = new Map<string, number>();
  const pts: Pt[] = [], xy: XY[] = [], adj: Edge[][] = [], segs: { a: number; b: number }[] = [];
  const node = (p: Pt) => {
    const k = key(p);
    let i = ids.get(k);
    if (i === undefined) { i = pts.length; ids.set(k, i); pts.push(p); xy.push(toXY(p)); adj.push([]); }
    return i;
  };
  const link = (a: number, b: number, factor = 1, isSeg = true) => {
    if (a === b) return;
    const w = dist(xy[a], xy[b]) * factor;
    adj[a].push({ to: b, w }); adj[b].push({ to: a, w });
    if (isSeg) segs.push({ a, b });
  };
  const ends: number[] = [];
  fc.features.forEach((f) => {
    if ((f.properties.kind !== "road" && f.properties.kind !== "path") || f.geometry.type !== "LineString") return;
    const line = f.geometry.coordinates as Pt[];
    let prev = node(line[0]);
    ends.push(prev);
    for (let i = 1; i < line.length; i++) { const cur = node(line[i]); link(prev, cur); prev = cur; }
    ends.push(prev);
  });

  const blds: Bld[] = [];
  const bGrid = new Map<string, number[]>();
  fc.features.forEach((f) => {
    if (f.properties.kind !== "building" || f.geometry.type !== "Polygon") return;
    const ring = (f.geometry.coordinates[0] as Pt[]).map(toXY);
    if (ring.length < 3) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ring.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
    gridAddBox(bGrid, blds.length, x0, y0, x1, y1);
    blds.push({ ring, x0, y0, x1, y1 });
  });

  const nGrid = new Map<string, number[]>();
  xy.forEach((q, i) => gridAddBox(nGrid, i, q[0], q[1], q[0], q[1]));
  const sGrid = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const A = xy[s.a], B = xy[s.b];
    gridAddBox(sGrid, i, Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1]));
  });

  const g: Graph = { pts, xy, adj, segs, blds, bGrid, nGrid, sGrid };

  // Mend tiny gaps: two line ends within 4 m of each other count as one junction.
  for (const a of ends) {
    for (const b of gridQuery(nGrid, xy[a][0] - 4, xy[a][1] - 4, xy[a][0] + 4, xy[a][1] + 4)) {
      if (a < b && ends.includes(b) && dist(xy[a], xy[b]) < 4 && !adj[a].some((e) => e.to === b)) link(a, b);
    }
  }

  // Shortcuts across open ground: each path point links to up to 6 nearby path points it can see,
  // when going round by the paths would be clearly longer.
  const n = xy.length;
  for (let a = 0; a < n; a++) {
    const A = xy[a];
    const near = gridQuery(nGrid, A[0] - SHORTCUT_M, A[1] - SHORTCUT_M, A[0] + SHORTCUT_M, A[1] + SHORTCUT_M)
      .filter((b) => b > a)
      .map((b) => ({ b, d: dist(A, xy[b]) }))
      .filter((o) => o.d > 3 && o.d <= SHORTCUT_M)
      .sort((p, q) => p.d - q.d);
    let added = 0;
    for (const { b, d } of near) {
      if (added >= 6) break;
      if (adj[a].some((e) => e.to === b)) continue;
      // Skip if the paths already join them within a short way (two hops and not much longer).
      let viaPaths = Infinity;
      for (const e1 of adj[a]) {
        if (e1.to === b) viaPaths = Math.min(viaPaths, e1.w);
        for (const e2 of adj[e1.to]) if (e2.to === b) viaPaths = Math.min(viaPaths, e1.w + e2.w);
      }
      if (viaPaths <= d * OPEN) continue;
      if (!clear(g, A, xy[b])) continue;
      const w = d * OPEN;
      adj[a].push({ to: b, w }); adj[b].push({ to: a, w });
      added++;
    }
  }
  return g;
}

type Link = { node: number; w: number; via?: XY }; // a way onto the network: reach `node` costing w, passing `via`

/** Ways from a free point (the student, or a side of a building) onto the network. */
function linksFrom(g: Graph, q: XY, skip: number, reach: number): Link[] {
  const out: Link[] = [];
  // 1. Straight onto the nearest point of each nearby road stretch, then along it to either end.
  const segIds = gridQuery(g.sGrid, q[0] - reach, q[1] - reach, q[0] + reach, q[1] + reach);
  const snaps: { s: number; off: number; x: XY; da: number; db: number }[] = [];
  for (const si of segIds) {
    const s = g.segs[si];
    const A = g.xy[s.a], B = g.xy[s.b];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2)) : 0;
    const x: XY = [A[0] + t * dx, A[1] + t * dy];
    const off = dist(q, x);
    if (off > reach) continue;
    const len = Math.sqrt(L2);
    snaps.push({ s: si, off, x, da: t * len, db: (1 - t) * len });
  }
  snaps.sort((a, b) => a.off - b.off);
  let used = 0;
  for (const sn of snaps) {
    if (used >= 4) break;
    if (sn.off > 1 && !clear(g, q, sn.x, skip)) continue;
    const s = g.segs[sn.s];
    const w0 = sn.off * (sn.off < 12 ? 1 : OPEN); // a step or two onto the path is normal walking
    out.push({ node: s.a, w: w0 + sn.da, via: sn.x }, { node: s.b, w: w0 + sn.db, via: sn.x });
    used++;
  }
  // 2. Straight to nearby path points it can see.
  const near = gridQuery(g.nGrid, q[0] - reach, q[1] - reach, q[0] + reach, q[1] + reach)
    .map((i) => ({ i, d: dist(q, g.xy[i]) }))
    .filter((o) => o.d <= reach)
    .sort((a, b) => a.d - b.d)
    .slice(0, 24);
  for (const { i, d } of near) if (clear(g, q, g.xy[i], skip)) out.push({ node: i, w: d * OPEN });
  return out;
}

/** Points every few metres along a building's walls: the places someone can walk up to. */
function sidesOf(ring0: XY[]): XY[] {
  const f = ring0[0], l = ring0[ring0.length - 1];
  const ring = f[0] === l[0] && f[1] === l[1] ? ring0 : [...ring0, f];
  let perim = 0;
  for (let i = 1; i < ring.length; i++) perim += dist(ring[i - 1], ring[i]);
  const step = Math.max(4, perim / 60);
  const out: XY[] = [];
  let carry = 0;
  for (let i = 1; i < ring.length; i++) {
    const A = ring[i - 1], B = ring[i];
    const L = dist(A, B);
    let t = carry;
    while (t < L) { out.push([A[0] + ((B[0] - A[0]) * t) / L, A[1] + ((B[1] - A[1]) * t) / L]); t += step; }
    carry = t - L;
  }
  // Nudge each point 0.6 m outwards so a line to it does not count as crossing the wall it stands on.
  const c: XY = [0, 0];
  ring.forEach((p) => { c[0] += p[0] / ring.length; c[1] += p[1] / ring.length; });
  return out.map((p) => {
    // Try both sides of the wall: keep the one outside the building.
    for (let k = 0; k < ring.length - 1; k++) {
      const A = ring[k], B = ring[k + 1];
      const L = dist(A, B);
      if (!L) continue;
      const along = ((p[0] - A[0]) * (B[0] - A[0]) + (p[1] - A[1]) * (B[1] - A[1])) / L;
      const perp = Math.abs((B[0] - A[0]) * (A[1] - p[1]) - (A[0] - p[0]) * (B[1] - A[1])) / L;
      if (perp > 0.01 || along < -0.01 || along > L + 0.01) continue;
      const nx = -(B[1] - A[1]) / L, ny = (B[0] - A[0]) / L;
      const p1: XY = [p[0] + nx * 0.6, p[1] + ny * 0.6], p2: XY = [p[0] - nx * 0.6, p[1] - ny * 0.6];
      return inRing(p1, ring) ? p2 : p1;
    }
    const dx = p[0] - c[0], dy = p[1] - c[1], L = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / L) * 0.6, p[1] + (dy / L) * 0.6] as XY;
  });
}

export type Route = { coords: Pt[]; metres: number; onRoads: boolean };

/**
 * Shortest walking route from `from` to a place. With the place's outline (`ring`), the route ends at the
 * nearest side of the building instead of its middle. Falls back to a straight line if nothing connects.
 */
export function findRoute(g: Graph, from: Pt, to: Pt, ring?: Pt[] | null): Route {
  const F = toXY(from);
  const straightTo = (p: XY): Route => ({ coords: [from, toPt(p)], metres: dist(F, p), onRoads: false });
  const n = g.xy.length;

  // Where the route may end: points around the building, or the place's own point.
  const R = ring && ring.length > 3 ? ring.map(toXY) : null;
  const doors: XY[] = R ? sidesOf(R) : [toXY(to)];
  if (R && inRing(F, R)) return { coords: [from], metres: 0, onRoads: false }; // already inside

  if (!g.segs.length) {
    let best = doors[0];
    doors.forEach((d) => { if (dist(F, d) < dist(F, best)) best = d; });
    return straightTo(best);
  }

  // Extra nodes: S (start) = n, T (end) = n + 1, door k = n + 2 + k, and junction points on road stretches.
  const S = n, T = n + 1;
  const extra = new Map<number, Edge[]>();
  const viaOf = new Map<string, XY>(); // "u>v" -> point passed between them (where a link meets a road stretch)
  const add = (u: number, v: number, w: number, via?: XY) => {
    (extra.get(u) || extra.set(u, []).get(u)!).push({ to: v, w });
    (extra.get(v) || extra.set(v, []).get(v)!).push({ to: u, w });
    if (via) { viaOf.set(u + ">" + v, via); viaOf.set(v + ">" + u, via); }
  };

  const startBld = buildingIndexAt(g, F); // someone indoors walks out of their own building
  let fromLinks = linksFrom(g, F, startBld, REACH_M);
  if (!fromLinks.length) fromLinks = linksFrom(g, F, -2, 250).filter((l) => l.via).slice(0, 2); // last resort: nearest road
  fromLinks.forEach((l) => add(S, l.node, l.w, l.via));

  const doorNode = (k: number) => n + 2 + k;
  doors.forEach((d, k) => {
    add(doorNode(k), T, 0);
    linksFrom(g, d, -1, R ? 45 : REACH_M).forEach((l) => add(doorNode(k), l.node, l.w, l.via));
    // Close enough to walk straight there.
    const dd = dist(F, d);
    if (dd < 150 && clear(g, F, d, startBld)) add(S, doorNode(k), dd * (dd < 12 ? 1 : OPEN));
  });
  if (![...doors.keys()].some((k) => (extra.get(doorNode(k))?.length ?? 0) > 1)) {
    // No side of the building can be reached in a straight line: go to the road nearest its middle.
    linksFrom(g, toXY(to), -2, 250).filter((l) => l.via).slice(0, 2).forEach((l) => add(T, l.node, l.w, l.via));
  }

  const total = n + 2 + doors.length;
  const d = new Float64Array(total).fill(Infinity);
  const prev = new Int32Array(total).fill(-1);
  const done = new Uint8Array(total);
  d[S] = 0;
  const heap: [number, number][] = [[0, S]];
  const push = (it: [number, number]) => {
    heap.push(it);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [du, u] = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === T) break;
    const relax = (e: Edge) => {
      if (du + e.w < d[e.to]) { d[e.to] = du + e.w; prev[e.to] = u; push([d[e.to], e.to]); }
    };
    if (u < n) g.adj[u].forEach(relax);
    extra.get(u)?.forEach(relax);
  }
  if (!isFinite(d[T])) {
    let best = doors[0];
    doors.forEach((p) => { if (dist(F, p) < dist(F, best)) best = p; });
    return straightTo(best);
  }

  // Walk the chain back from the end.
  const chain: number[] = [];
  for (let u = T; u !== -1; u = prev[u]) chain.push(u);
  chain.reverse(); // S ... T
  const posOf = (u: number): XY | null =>
    u === S ? F : u === T ? null : u < n ? g.xy[u] : doors[u - n - 2];
  const line: XY[] = [];
  for (let i = 0; i < chain.length; i++) {
    const u = chain[i];
    if (i > 0) { const via = viaOf.get(chain[i - 1] + ">" + u); if (via) line.push(via); }
    const p = posOf(u);
    if (p) line.push(p);
  }
  // Ended on the fallback road: finish at the building's nearest side.
  const lastNode = chain[chain.length - 2];
  if (lastNode !== undefined && (lastNode < n || lastNode === S) && line.length) {
    const end = line[line.length - 1];
    let best = doors[0];
    doors.forEach((p) => { if (dist(end, p) < dist(end, best)) best = p; });
    line.push(best);
  }

  const smooth = straighten(g, line, startBld);
  const coords = dedupe(smooth).map(toPt);
  let metres = 0;
  for (let i = 1; i < smooth.length; i++) metres += dist(smooth[i - 1], smooth[i]);
  return { coords, metres, onRoads: true };
}

function dedupe(line: XY[]): XY[] {
  const out: XY[] = [];
  line.forEach((p) => { if (!out.length || dist(out[out.length - 1], p) > 0.5) out.push(p); });
  return out;
}

/**
 * Take out needless bends: from each point, jump to the farthest later point that can be reached in a
 * straight line, either because the skipped part was almost straight anyway (under 2.5 m off the line),
 * or because cutting across is clearly shorter even counted as open ground.
 */
function straighten(g: Graph, raw: XY[], startBld: number): XY[] {
  const line = dedupe(raw);
  if (line.length < 3) return line;
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  const offLine = (a: XY, b: XY, p: XY) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return dist(p, [a[0] + t * dx, a[1] + t * dy]);
  };
  const out: XY[] = [line[0]];
  let i = 0;
  while (i < line.length - 1) {
    let next = i + 1;
    for (let j = line.length - 1; j > i + 1; j--) {
      const a = line[i], b = line[j];
      const direct = dist(a, b);
      let maxOff = 0;
      for (let k = i + 1; k < j && maxOff <= 2.5; k++) maxOff = Math.max(maxOff, offLine(a, b, line[k]));
      const worth = maxOff <= 2.5 || direct * OPEN < cum[j] - cum[i] - 2;
      if (!worth || direct > 120) continue;
      if (!clear(g, a, b, i === 0 ? startBld : -1)) continue;
      next = j;
      break;
    }
    out.push(line[next]);
    i = next;
  }
  return out;
}

/** Length of a line of [lng, lat] points, in metres. */
export function lineMetres(coords: Pt[]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += dist(toXY(coords[i - 1]), toXY(coords[i]));
  return m;
}

/**
 * Where someone is along a route they are walking: how far they are from the line, and the part
 * still ahead of them (starting at their own spot). Used to keep the line steady while walking.
 */
export function progressAlong(coords: Pt[], at: Pt): { off: number; ahead: Pt[]; metresLeft: number } {
  const q = toXY(at);
  const xy = coords.map(toXY);
  if (xy.length < 2) return { off: xy.length ? dist(q, xy[0]) : Infinity, ahead: [at], metresLeft: 0 };
  let best = { off: Infinity, i: 0, x: xy[0] };
  for (let i = 0; i < xy.length - 1; i++) {
    const A = xy[i], B = xy[i + 1];
    const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2)) : 0;
    const x: XY = [A[0] + t * dx, A[1] + t * dy];
    const off = dist(q, x);
    if (off < best.off - 0.01) best = { off, i, x };
  }
  const rest = xy.slice(best.i + 1);
  const ahead = [q, ...(dist(q, best.x) > 1 ? [best.x] : []), ...rest];
  let metresLeft = 0;
  for (let i = 1; i < ahead.length; i++) metresLeft += dist(ahead[i - 1], ahead[i]);
  return { off: best.off, ahead: dedupe(ahead).map(toPt), metresLeft };
}

/** Direction (degrees from north, clockwise) from a point to the spot `metres` further along a line. */
export function bearingAhead(coords: Pt[], metres = 25): number | null {
  const xy = coords.map(toXY);
  if (xy.length < 2) return null;
  let left = metres;
  let target = xy[xy.length - 1];
  for (let i = 1; i < xy.length; i++) {
    const L = dist(xy[i - 1], xy[i]);
    if (L >= left) { const t = left / L; target = [xy[i - 1][0] + (xy[i][0] - xy[i - 1][0]) * t, xy[i - 1][1] + (xy[i][1] - xy[i - 1][1]) * t]; break; }
    left -= L;
  }
  const a = xy[0];
  if (dist(a, target) < 3) return null;
  return (Math.atan2(target[0] - a[0], target[1] - a[1]) * 180) / Math.PI;
}
