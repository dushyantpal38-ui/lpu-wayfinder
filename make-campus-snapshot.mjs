// make-campus-snapshot.mjs
// Builds public/campus-raw.json for LPU Wayfinder straight from the OpenStreetMap API
// (Overpass is currently failing, which leaves the live map blank for new visitors).
// It also adds footprints for campus buildings that are missing from OpenStreetMap.
//
// Run from the project folder (Windows cmd):
//   node make-campus-snapshot.mjs
// then deploy:
//   npx vercel --prod
// It also runs automatically before every `npm run build` (see package.json),
// so each Vercel deploy refreshes the map data. If OSM is unreachable the build continues without it.

import { writeFileSync, mkdirSync } from "node:fs";

const API = "https://api.openstreetmap.org/api/0.6";
const BBOX = "75.688,31.238,75.724,31.264"; // same box the app uses
const CAMPUS_REL = 21599790;

// Buildings seen on satellite imagery (Esri, Nov 2026) and on the Behance isometric map
// but missing from OpenStreetMap. Traced as simple rectangles. [lng, lat] rings.
// The block numbers come from Supabase (campus_blocks), not from these shapes.
const EXTRA_BUILDINGS = [
  { note: "Block 7 (Pharmacy) - tall block of the 6/7/8 complex", ring: [[75.7067341,31.2569429],[75.7071633,31.2569429],[75.7071633,31.2567136],[75.7067341,31.2567136],[75.7067341,31.2569429]] },
  { note: "Block 6 (Architecture)", ring: [[75.7072437,31.2569246],[75.7076997,31.2569246],[75.7076997,31.2566127],[75.7072437,31.2566127],[75.7072437,31.2569246]] },
  { note: "Block 8 (Animation & Fine Arts) - lower wing of the complex", ring: [[75.7066805,31.2566586],[75.7072437,31.2566586],[75.7072437,31.2564293],[75.7066805,31.2564293],[75.7066805,31.2566586]] },
  { note: "Square courtyard building north-east of block 13 (number not confirmed)", ring: [[75.7059026,31.255214],[75.7064122,31.255214],[75.7064122,31.2548472],[75.7059026,31.2548472],[75.7059026,31.255214]] },
  { note: "Grey building beside the girls hostels (number not confirmed)", ring: [[75.705967,31.2570392],[75.7062245,31.2570392],[75.7062245,31.2566357],[75.705967,31.2566357],[75.705967,31.2570392]] },
];

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "lpu-wayfinder-snapshot/1.0" }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const [map, rel] = await Promise.all([
  getJson(`${API}/map.json?bbox=${BBOX}`),
  getJson(`${API}/relation/${CAMPUS_REL}/full.json`),
]);

const nodes = new Map();
const ways = new Map();
for (const e of [...map.elements, ...rel.elements]) {
  if (e.type === "node") nodes.set(e.id, e);
  else if (e.type === "way") ways.set(e.id, e);
}
const geom = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean).map((n) => ({ lat: round(n.lat), lon: round(n.lon) }));

// Only the tags lib/campus.ts reads (buildCollection). Everything else is dropped to keep the file small.
const KEEP = ["building", "highway", "leisure", "landuse", "amenity", "shop", "name", "ref", "addr:housename", "building:name", "height", "building:levels"];
const slim = (t = {}) => Object.fromEntries(KEEP.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
// 6 decimals is about 11 cm, finer than any phone GPS.
const round = (v) => Math.round(v * 1e6) / 1e6;

const relation = rel.elements.find((e) => e.type === "relation" && e.id === CAMPUS_REL);
if (!relation) throw new Error("Campus relation not found");

// Same shape as Overpass "out geom", which is what the app reads.
const elements = [{
  type: "relation",
  id: relation.id,
  // The app only uses the outline: way members with their points.
  members: relation.members
    .filter((m) => m.type === "way" && ways.get(m.ref))
    .map((m) => ({ type: "way", role: m.role, geometry: geom(ways.get(m.ref)) })),
}];

let buildings = 0;
for (const w of ways.values()) {
  const t = w.tags || {};
  if (!(t.building || t.highway || t.leisure || t.landuse)) continue;
  const g = geom(w);
  if (g.length !== w.nodes.length) continue; // skip ways cut by the box edge
  elements.push({ type: "way", tags: slim(t), geometry: g }); // the app does not read way ids
  if (t.building) buildings++;
}

EXTRA_BUILDINGS.forEach((b) => {
  elements.push({
    type: "way",
    tags: { building: "yes" }, // b.note says which building it is; the app does not need it
    geometry: b.ring.map(([lon, lat]) => ({ lat, lon })),
  });
});

mkdirSync("public", { recursive: true });
writeFileSync("public/campus-raw.json", JSON.stringify({ generator: "make-campus-snapshot.mjs", made: new Date().toISOString(), elements }));
console.log(`Wrote public/campus-raw.json: ${elements.length} elements, ${buildings} OSM buildings + ${EXTRA_BUILDINGS.length} added.`);
console.log("Now deploy with: npx vercel --prod");
