import { NextResponse } from "next/server";

// Fetches the LPU campus (buildings, roads, outline) from OpenStreetMap on the server, once a day, and shares the result
// with every visitor. Browsers then no longer depend on OpenStreetMap's servers being reachable or fast.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REL = 21599790;
const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const Q1 = `[out:json][timeout:50];rel(${REL});map_to_area->.a;(rel(${REL});way(area.a)["building"];way(area.a)["highway"];way(area.a)["leisure"];way(area.a)["landuse"];);out geom;`;
const Q2 = `[out:json][timeout:50];rel(${REL})->.r;(.r;way["building"](31.238,75.688,31.264,75.724);way["highway"](31.238,75.688,31.264,75.724););out geom;`;

type Osm = { elements: { type: string }[] };

async function ask(q: string): Promise<Osm> {
  const errors: string[] = [];
  for (const url of SERVERS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "lpu-wayfinder/0.1 (college project)", Accept: "application/json" },
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(25000),
        cache: "no-store",
      });
      if (!r.ok) { errors.push(`${new URL(url).host}: HTTP ${r.status}`); continue; }
      const d = (await r.json()) as Osm;
      if (!Array.isArray(d.elements)) { errors.push(`${new URL(url).host}: no data`); continue; }
      return d;
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(errors.join("; "));
}

export async function GET() {
  try {
    let d = await ask(Q1);
    if (!d.elements.some((e) => e.type === "way")) d = await ask(Q2);
    return NextResponse.json(d, { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
