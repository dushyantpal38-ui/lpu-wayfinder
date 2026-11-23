import type { DbBlock, DbLabel } from "@/lib/campus";

// Public values. The publishable key is meant for browsers. Never put a service_role key here.
const URL_ = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://zypkjzwkbkmnqhpziade.supabase.co").replace(/\/+$/, "");
const KEY = process.env.NEXT_PUBLIC_SUPABASE_KEY || "sb_publishable_odtqlx_y5JYxXuQlq7Bm0A_fYVBeVNX";

function headers(): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`; // legacy JWT keys only
  return h;
}

async function get<T>(path: string, cacheKey: string): Promise<T> {
  try {
    const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: headers(), cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const rows = (await r.json()) as T;
    try { localStorage.setItem(cacheKey, JSON.stringify(rows)); } catch { /* ignore */ }
    return rows;
  } catch (err) {
    // Offline or blocked: use the last saved copy if there is one.
    try {
      const c = localStorage.getItem(cacheKey);
      if (c) return JSON.parse(c) as T;
    } catch { /* ignore */ }
    throw err;
  }
}

export const fetchBlocks = () =>
  get<DbBlock[]>("campus_blocks?select=block_no,name,category,aliases,lng,lat,hidden&order=id.asc", "lpuBlocksNextV1");

export const fetchLabels = () =>
  get<DbLabel[]>("campus_labels?select=key,text,lng,lat,size&order=id.asc", "lpuLabelsNextV1");

/** Calls a database function (the owner's save and delete go through these; they check the owner passcode). */
export async function rpc<T>(fn: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
    signal,
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return (await r.json()) as T;
}
