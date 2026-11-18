import { rpc } from "@/lib/supabase";
import type { DbBlock } from "@/lib/campus";

// Owner editing. The editor shows only with ?admin=1 in the address, and saving needs the owner passcode,
// which the database checks (see the owner_* functions in Supabase). Students can only read the map.

/** True when the address has ?admin=1. This only shows the editor; it cannot change anything by itself. */
export function readAdminFlag(): boolean {
  try { return new URLSearchParams(window.location.search).get("admin") === "1"; } catch { return false; }
}

// The passcode is typed once and swapped for a device token ("ows_..."), valid 30 days, that the database can
// cancel (Lock, or owner_logout_all() in the SQL Editor). The passcode itself is never kept on the phone.
const TOKEN_KEY = "lpuOwnerToken";
const OLD_PASS_KEY = "lpuOwnerPass"; // before 18 Nov 2026 the passcode itself was kept here

/** This device's owner token, if the owner unlocked editing here. */
export function loadPasscode(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function savePasscode(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(OLD_PASS_KEY);
  } catch { /* storage blocked */ }
}

/** A passcode saved by the older version of the site (to swap for a token once, then forget). */
export function takeOldPasscode(): string | null {
  try {
    const p = localStorage.getItem(OLD_PASS_KEY);
    localStorage.removeItem(OLD_PASS_KEY);
    return p;
  } catch { return null; }
}

/** True on the owner's own devices (their visits are not counted in the stats). */
export function isOwnerDevice(): boolean {
  try { return !!(localStorage.getItem(TOKEN_KEY) || localStorage.getItem(OLD_PASS_KEY)); } catch { return false; }
}

/** One label as the owner saves it: a block number, or a named place (block_no made from the name). */
export type OwnerRow = {
  block_no: string;
  old_no?: string; // the label's previous number, when the number itself changes
  name: string;
  category: string;
  lng: number | null;
  lat: number | null;
  hidden: boolean;
};

export type OwnerResult = { ok: boolean; error?: string | null; row?: DbBlock };

export const ownerCheck = (key: string) => rpc<OwnerResult>("owner_check", { p_key: key });
export const ownerLogin = (pass: string) => rpc<{ ok: boolean; token?: string; error?: string | null }>("owner_login", { p_pass: pass });
export const ownerLogout = (token: string) => rpc<{ ok: boolean }>("owner_logout", { p_token: token });
export const ownerStats = (key: string, days: number) => rpc<OwnerStats>("owner_stats", { p_key: key, p_days: days });

export type StatPlace = { place: string; name: string | null; opens: number; users: number; per_user: number; regulars: number; last: string };
export type StatRegular = {
  id: string; opens: number; days_active: number; first_seen: string; last: string;
  top_place: string | null; top_place_name: string | null; top_place_opens: number | null;
};
export type OwnerStats = {
  ok: boolean;
  error?: string | null;
  days?: number;
  totals?: {
    visitors_all_time: number; opens_all_time: number;
    new_today: number; new_7d: number; new_period: number;
    opens_today: number; opens_7d: number; opens_period: number;
    users_today: number; users_7d: number; users_period: number;
    returning_period: number; on_campus_share: number | null; with_location: number; app_opens: number;
  };
  daily?: { day: string; opens: number; new: number; users: number }[];
  hours?: number[];
  places?: StatPlace[];
  areas?: { campus: number; off_campus: number; unknown: number };
  cities?: { city: string; country: string | null; opens: number; users: number }[];
  devices?: Record<string, number>;
  sources?: Record<string, number>;
  regulars?: StatRegular[];
};
export const ownerSave = (key: string, row: OwnerRow) => rpc<OwnerResult>("owner_save_block", { p_key: key, p_row: row });
export const ownerDelete = (key: string, blockNo: string) => rpc<OwnerResult>("owner_delete_block", { p_key: key, p_block_no: blockNo });

/** Plain words for what the database sends back. */
export function ownerError(code?: string | null): string {
  switch (code) {
    case "wrong": return "That passcode is wrong.";
    case "locked": return "Too many wrong tries. Editing is locked for 1 hour.";
    case "expired": return "This device was signed out. Type your passcode again.";
    case "not_set": return "No owner passcode is set yet.";
    case "bad_number": return "Use numbers and letters only, like 34 or 21A.";
    case "bad_name": return "Type a name of up to 80 characters.";
    case "number_taken": return "That number is already on the map. Move or delete that one first.";
    case "outside_campus": return "That spot is outside the campus.";
    default: return "Couldn't save. Check your internet and try again.";
  }
}

/** An id for a named place, made from its name: "Food court" becomes "P-FOOD-COURT" (with -2, -3... if taken). */
export function placeId(name: string, taken: Set<string>): string {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  const base = "P-" + (slug || "PLACE");
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}
