import { NextRequest, NextResponse } from "next/server";

// Receives anonymous visit counts from the site itself and passes them to the database with the ingest key
// (VISIT_INGEST_KEY, a server-only setting on Vercel). The browser never sees that key, so nobody can write
// visits straight into the database. The city comes from Vercel's network headers. Coordinates are only
// forwarded so the database can pick the nearest block; they are not stored anywhere.

export const dynamic = "force-dynamic";

const URL_ = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://zypkjzwkbkmnqhpziade.supabase.co").replace(/\/+$/, "");
const KEY = process.env.NEXT_PUBLIC_SUPABASE_KEY || "sb_publishable_odtqlx_y5JYxXuQlq7Bm0A_fYVBeVNX";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${KEY}`;
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function header(req: NextRequest, name: string): string | null {
  const v = req.headers.get(name);
  if (!v) return null;
  try { return decodeURIComponent(v).slice(0, 60); } catch { return v.slice(0, 60); }
}

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(req: NextRequest) {
  const ingest = process.env.VISIT_INGEST_KEY;
  if (!ingest) return reply({ id: null }); // stats switched off

  // Only our own pages may send visits.
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  try {
    if (!origin || !host || new URL(origin).host !== host) return reply({ error: "forbidden" }, 403);
  } catch {
    return reply({ error: "forbidden" }, 403);
  }

  const raw = await req.text();
  if (raw.length > 1000) return reply({ error: "too_big" }, 413);
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw) as Record<string, unknown>; } catch { return reply({ error: "bad_json" }, 400); }
  if (!b || typeof b !== "object" || typeof b.v !== "string" || !UUID.test(b.v)) return reply({ error: "bad_request" }, 400);

  try {
    if (b.t === "open") {
      const id = await rpc("log_visit", {
        p_ingest: ingest,
        p_visitor: b.v,
        p_device: typeof b.d === "string" ? b.d : null,
        p_app: b.app === true,
        p_source: typeof b.src === "string" ? b.src.slice(0, 32) : null,
        p_city: header(req, "x-vercel-ip-city"),
        p_region: header(req, "x-vercel-ip-country-region"),
        p_country: header(req, "x-vercel-ip-country"),
      });
      return reply({ id: typeof id === "number" ? id : null });
    }
    if (b.t === "place") {
      const lng = Number(b.lng), lat = Number(b.lat), id = Number(b.id);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isSafeInteger(id) || id <= 0) return reply({ error: "bad_request" }, 400);
      await rpc("visit_place", { p_ingest: ingest, p_visit: id, p_visitor: b.v, p_lng: lng, p_lat: lat });
      return reply({ ok: true });
    }
    return reply({ error: "bad_request" }, 400);
  } catch {
    return reply({ error: "unavailable" }, 502);
  }
}

export function GET() {
  return reply({ error: "method_not_allowed" }, 405);
}
