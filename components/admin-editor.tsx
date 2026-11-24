"use client";

import * as React from "react";
import { BarChart3, Copy, Eye, EyeOff, Lock, Move, Pencil, Plus, Trash2, X } from "lucide-react";
import { useCampus } from "@/components/campus-provider";
import { BlockPlate } from "@/components/block-plate";
import dynamic from "next/dynamic";
import { buildingAtPoint, distanceMetres, isNamed, numCmp, pointInRing, type DbBlock, type Pt } from "@/lib/campus";
import {
  loadPasscode, ownerDelete, ownerError, ownerLogin, ownerLogout, ownerSave, placeId, savePasscode, takeOldPasscode, type OwnerRow,
} from "@/lib/admin";
import { cn } from "@/lib/utils";

// The stats screen is only downloaded when the owner opens it.
const VisitorStats = dynamic(() => import("@/components/visitor-stats").then((m) => m.VisitorStats), { ssr: false });

// Owner-only map editing: add, change, move, hide or delete block numbers and named places (buildings without a
// number, parks, food courts). Shown only with ?admin=1 in the address; every save is checked against the owner
// passcode by the database, so students can never change the map.

const GLASS = "bg-zinc-950/95 ring-1 ring-white/10 backdrop-blur-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)]";
const FIELD = "h-11 w-full rounded-xl bg-white/[0.06] px-3 text-base text-white outline-none ring-1 ring-inset ring-white/10 placeholder:text-zinc-500 focus:ring-2 focus:ring-amber-400";

const KINDS = [
  { id: "academic", label: "Academic" },
  { id: "hostel", label: "Hostel" },
  { id: "food", label: "Food" },
  { id: "park", label: "Park" },
  { id: "sports", label: "Sports" },
  { id: "other", label: "Other" },
];
const KIND_NAME: Record<string, string> = { academic: "Academic block", hostel: "Hostel", food: "Food and shops", park: "Park", sports: "Sports", other: "Building" };

// Run once in the Supabase SQL editor, with the owner's own passcode in place of the example.
const SETUP_SQL = "select set_owner_passcode('type-your-passcode-here');";

type Form = {
  old: DbBlock | null; // the label being changed (null when adding a new one)
  kind: "number" | "name";
  no: string;
  name: string;
  category: string;
  hidden: boolean;
  at: Pt | null; // where it goes on the map
};

const placedAt = (r: DbBlock): Pt | null => (typeof r.lng === "number" && typeof r.lat === "number" ? [r.lng, r.lat] : null);
const titleOfRow = (r: DbBlock) => (isNamed(r.block_no) ? r.name : `Block ${r.block_no}`);
const rowOf = (r: DbBlock): OwnerRow => ({ block_no: r.block_no, name: r.name, category: r.category || "other", lng: r.lng, lat: r.lat, hidden: !!r.hidden });
const byNumber = (a: DbBlock, b: DbBlock) => numCmp(a.block_no, b.block_no);

/** A small icon button in a label's row. */
function Tool({ label, onClick, disabled, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40",
        danger && "hover:bg-rose-500/20 hover:text-rose-300",
      )}
    >
      {children}
    </button>
  );
}

export function AdminEditor({ onStart }: { onStart?: () => void }) {
  const c = useCampus();
  const [pass, setPass] = React.useState<string | null>(null); // this device's owner token (not the passcode)
  const [stats, setStats] = React.useState(false); // showing the visitor numbers
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ text: string; bad?: boolean } | null>(null);
  const [needSetup, setNeedSetup] = React.useState(false);
  const [form, setForm] = React.useState<Form | null>(null);
  const [moving, setMoving] = React.useState<DbBlock | null>(null); // the label waiting for its new spot
  const [confirm, setConfirm] = React.useState<string | null>(null); // the label asking "Delete?"
  const [list, setList] = React.useState<"hidden" | "unplaced" | null>(null);
  const seenTap = React.useRef(0);

  React.useEffect(() => {
    const token = loadPasscode();
    if (token) { setPass(token); return; }
    // An older version of the site kept the passcode itself on this phone: swap it for a token once.
    const old = takeOldPasscode();
    if (!old) return;
    ownerLogin(old)
      .then((r) => { if (r.ok && r.token) { savePasscode(r.token); setPass(r.token); } })
      .catch(() => { /* offline: the owner types the passcode again */ });
  }, []);

  const failed = (code?: string | null) => {
    if (code === "wrong" || code === "not_set" || code === "expired") { savePasscode(null); setPass(null); setStats(false); }
    setNote({ text: ownerError(code), bad: true });
  };

  const save = async (row: OwnerRow, done: string): Promise<boolean> => {
    if (!pass) return false;
    setBusy(true);
    setNote(null);
    try {
      const r = await ownerSave(pass, row);
      if (!r.ok) { failed(r.error); return false; }
      await c.refreshBlocks();
      setNote({ text: done });
      return true;
    } catch {
      failed();
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Labels on one building each need their own spot. If the chosen point sits on another label (a label was
  // tapped), use the point inside the building that is farthest from the other labels.
  const roomAt = (at: Pt, self?: string): Pt => {
    const f = c.fc ? buildingAtPoint(c.fc, at) : null;
    if (!f || f.geometry.type !== "Polygon") return at;
    const ring = f.geometry.coordinates[0];
    const others = c.db.filter((r) => r.block_no !== self).map(placedAt).filter((p): p is Pt => !!p && pointInRing(p, ring));
    if (!others.some((o) => distanceMetres(o, at) < 4)) return at;
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    let best = at, bestGap = -1;
    for (let i = 0; i < 14; i++) {
      for (let j = 0; j < 14; j++) {
        const p: Pt = [x0 + ((i + 0.5) / 14) * (x1 - x0), y0 + ((j + 0.5) / 14) * (y1 - y0)];
        if (!pointInRing(p, ring)) continue;
        const gap = Math.min(...others.map((o) => distanceMetres(o, p)));
        if (gap > bestGap) { bestGap = gap; best = p; }
      }
    }
    return best;
  };

  const remove = async (r: DbBlock) => {
    if (!pass) return;
    setBusy(true);
    setNote(null);
    setConfirm(null);
    try {
      const res = await ownerDelete(pass, r.block_no);
      if (!res.ok) { failed(res.error); return; }
      await c.refreshBlocks();
      setNote({ text: `Deleted ${titleOfRow(r)}.` });
    } catch {
      failed();
    } finally {
      setBusy(false);
    }
  };

  // A tap on the map: put the label being moved there, or start working on that spot.
  React.useEffect(() => {
    const s = c.editSpot;
    if (!s || s.t === seenTap.current) return;
    seenTap.current = s.t;
    setConfirm(null);
    if (moving) {
      const m = moving;
      setMoving(null);
      const at = roomAt(s.at, m.block_no);
      void save({ ...rowOf(m), lng: at[0], lat: at[1] }, `Moved ${titleOfRow(m)}.`);
      return;
    }
    // While a form is open, a tap chooses where the label goes (the typing is kept).
    if (form) { setForm({ ...form, at: s.at }); return; }
    setNote(null);
  }, [c.editSpot]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!c.admin) return null;

  const start = () => { onStart?.(); c.setEditing(true); setNote(null); };

  if (!c.editing) {
    return (
      <button
        type="button"
        onClick={start}
        className="fixed left-3 top-[calc(max(0.75rem,env(safe-area-inset-top))_+_3.9rem)] z-30 flex h-11 items-center gap-2 rounded-2xl bg-amber-400 px-3.5 text-sm font-semibold text-zinc-950 shadow-[0_8px_24px_rgba(0,0,0,0.45)] hover:bg-amber-300 md:left-4"
      >
        <Pencil className="h-4 w-4" aria-hidden /> Edit map
      </button>
    );
  }

  const finish = () => {
    c.setEditing(false);
    c.clearEditSpot();
    setForm(null);
    setMoving(null);
    setConfirm(null);
    setList(null);
    setNote(null);
    setStats(false);
  };
  const lock = () => {
    if (pass) ownerLogout(pass).catch(() => { /* the token still expires by itself */ });
    savePasscode(null);
    setPass(null);
    setStats(false);
    setNote({ text: "Locked on this device." });
  };

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = typed.trim();
    if (!p || busy) return;
    setBusy(true);
    setNote(null);
    setNeedSetup(false);
    try {
      const r = await ownerLogin(p);
      if (r.ok && r.token) {
        savePasscode(r.token);
        setPass(r.token);
        setTyped("");
        setNote({ text: "Unlocked on this device." });
      } else {
        setNeedSetup(r.error === "not_set");
        setNote({ text: ownerError(r.error), bad: true });
      }
    } catch {
      setNote({ text: "Couldn't reach the database. Check your internet and try again.", bad: true });
    } finally {
      setBusy(false);
    }
  };

  const copySetup = async () => {
    try {
      await navigator.clipboard.writeText(SETUP_SQL);
      setNote({ text: "Copied. Paste it in Supabase, in the SQL Editor." });
    } catch {
      setNote({ text: "Couldn't copy. Select the line and copy it by hand.", bad: true });
    }
  };

  // What is at the tapped spot: the saved labels on that building, or named places within 30 m on open ground.
  const spot = c.editSpot?.at ?? null;
  const building = spot && c.fc ? buildingAtPoint(c.fc, spot) : null;
  const ring = building && building.geometry.type === "Polygon" ? building.geometry.coordinates[0] : null;
  const here = spot
    ? c.db.filter((r) => {
      const p = placedAt(r);
      if (!p) return false;
      if (ring) return pointInRing(p, ring);
      return distanceMetres(spot, p) <= 30 && !(c.fc && buildingAtPoint(c.fc, p));
    }).sort(byNumber)
    : [];
  const baseLabel = building && !here.length ? building.properties.label || "" : ""; // from OpenStreetMap
  const hiddenRows = c.db.filter((r) => r.hidden).sort(byNumber);
  const unplaced = c.db.filter((r) => !placedAt(r)).sort(byNumber);
  const typedNo = form && form.kind === "number" && !form.old ? form.no.trim().toUpperCase() : "";
  const clash = typedNo ? c.db.find((r) => r.block_no === typedNo) : undefined;

  const addNumber = () => { setNote(null); setForm({ old: null, kind: "number", no: "", name: "", category: "academic", hidden: false, at: spot }); };
  const addName = () => { setNote(null); setForm({ old: null, kind: "name", no: "", name: "", category: building ? "other" : "park", hidden: false, at: spot }); };
  const change = (r: DbBlock) => {
    setNote(null);
    setForm({ old: r, kind: isNamed(r.block_no) ? "name" : "number", no: isNamed(r.block_no) ? "" : r.block_no, name: r.name, category: r.category || "other", hidden: !!r.hidden, at: placedAt(r) });
  };
  const toggleHidden = (r: DbBlock) =>
    void save({ ...rowOf(r), hidden: !r.hidden }, r.hidden ? `${titleOfRow(r)} shows again.` : `${titleOfRow(r)} is hidden from students.`);
  // An OpenStreetMap label is hidden by saving a hidden label in its place.
  const hideBase = () => {
    if (!spot || !baseLabel) return;
    const isNum = /^\d/.test(baseLabel);
    const no = isNum ? baseLabel.toUpperCase() : placeId(baseLabel, new Set(c.db.map((r) => r.block_no)));
    void save({ block_no: no, name: isNum ? `Block ${no}` : baseLabel, category: "other", lng: spot[0], lat: spot[1], hidden: true }, `${baseLabel} is hidden.`);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || busy) return;
    const name = form.name.trim();
    let no: string;
    if (form.kind === "number") {
      no = form.no.trim().toUpperCase().replace(/\s+/g, "");
      if (!/^\d[0-9A-Z-]{0,9}$/.test(no)) { setNote({ text: "Type a block number that starts with a digit, like 34 or 21A.", bad: true }); return; }
    } else {
      if (!name) { setNote({ text: "Type a name, like Food court or Central park.", bad: true }); return; }
      no = form.old && isNamed(form.old.block_no) ? form.old.block_no : placeId(name, new Set(c.db.map((r) => r.block_no)));
    }
    const existing = c.db.find((r) => r.block_no === no);
    const at = form.at ? roomAt(form.at, form.old?.block_no ?? no) : null;
    const row: OwnerRow = {
      block_no: no,
      old_no: form.old && form.old.block_no !== no ? form.old.block_no : undefined,
      name: name || existing?.name || `Block ${no}`,
      category: form.category,
      lng: at ? at[0] : null,
      lat: at ? at[1] : null,
      hidden: form.hidden,
    };
    const what = form.kind === "number" ? no : name;
    if (await save(row, form.old ? `Saved ${what}.` : `Added ${what}.`)) setForm(null);
  };

  const row = (r: DbBlock) => (
    <li key={r.block_no} className="flex items-center gap-2 rounded-xl bg-white/[0.04] p-1.5 pl-2 ring-1 ring-inset ring-white/10">
      <BlockPlate num={r.block_no} category={r.category || undefined} size="sm" className={cn(r.hidden && "opacity-50")} />
      <span className={cn("min-w-0 flex-1", r.hidden && "opacity-60")}>
        <span className="block truncate font-medium text-white">{titleOfRow(r)}</span>
        <span className="block truncate text-xs text-zinc-400">
          {isNamed(r.block_no) ? KIND_NAME[r.category || "other"] || "Place" : r.name}
          {r.hidden ? ", hidden" : ""}
          {placedAt(r) ? "" : ", not on the map"}
        </span>
      </span>
      {confirm === r.block_no ? (
        <>
          <button type="button" onClick={() => void remove(r)} disabled={busy} className="h-9 shrink-0 rounded-lg bg-rose-500 px-3 text-sm font-semibold text-white disabled:opacity-50">Delete</button>
          <button type="button" onClick={() => setConfirm(null)} className="h-9 shrink-0 rounded-lg bg-white/10 px-3 text-sm text-white">Keep</button>
        </>
      ) : (
        <>
          <Tool label="Change" onClick={() => change(r)}><Pencil className="h-4 w-4" /></Tool>
          <Tool label={placedAt(r) ? "Move" : "Put on the map"} onClick={() => { setMoving(r); setNote(null); }}><Move className="h-4 w-4" /></Tool>
          <Tool label={r.hidden ? "Show to students" : "Hide from students"} onClick={() => toggleHidden(r)} disabled={busy}>
            {r.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Tool>
          <Tool label="Delete" onClick={() => setConfirm(r.block_no)} danger><Trash2 className="h-4 w-4" /></Tool>
        </>
      )}
    </li>
  );

  let body: React.ReactNode;
  if (pass && stats) {
    body = <VisitorStats token={pass} onSignedOut={(code) => failed(code)} />;
  } else if (!pass) {
    body = (
      <form onSubmit={unlock} className="space-y-3">
        <p className="text-zinc-300">Type your owner passcode to change the map. Students can only look at it.</p>
        <div className="flex gap-2">
          <input
            type="password"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Owner passcode"
            aria-label="Owner passcode"
            autoComplete="current-password"
            className={cn(FIELD, "min-w-0 flex-1")}
          />
          <button type="submit" disabled={busy || !typed.trim()} className="h-11 shrink-0 rounded-xl bg-amber-400 px-4 font-semibold text-zinc-950 hover:bg-amber-300 disabled:opacity-50">
            {busy ? "Checking…" : "Unlock"}
          </button>
        </div>
        {needSetup && (
          <div className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-inset ring-white/10">
            <p className="text-zinc-300">
              Set your passcode once: open your Supabase project, go to <span className="text-white">SQL Editor</span>, paste this line,
              change the example to your own passcode (at least 8 characters), and press Run.
            </p>
            <code className="mt-2 block break-all rounded-lg bg-black/40 p-2 font-mono text-xs text-amber-200">{SETUP_SQL}</code>
            <button type="button" onClick={copySetup} className="mt-2 flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-sm font-medium text-white hover:bg-white/15">
              <Copy className="h-4 w-4" aria-hidden /> Copy the line
            </button>
          </div>
        )}
      </form>
    );
  } else if (moving) {
    body = (
      <div className="space-y-3">
        <p className="text-base text-white">Tap the spot where <span className="font-semibold">{titleOfRow(moving)}</span> should go.</p>
        <button type="button" onClick={() => setMoving(null)} className="h-10 rounded-xl bg-white/10 px-4 font-semibold text-white hover:bg-white/15">Cancel</button>
      </div>
    );
  } else if (form) {
    body = (
      <form onSubmit={submit} className="space-y-3">
        <p className="text-base font-medium text-white">
          {form.old ? `Change ${titleOfRow(form.old)}` : form.kind === "number" ? "Add a block number" : "Add a name"}
        </p>
        {form.kind === "number" && (
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">Block number</span>
            <input
              value={form.no}
              onChange={(e) => {
                const v = e.target.value.toUpperCase();
                const ex = !form.old ? c.db.find((r) => r.block_no === v.trim()) : undefined;
                setForm({ ...form, no: v, ...(ex ? { name: form.name || ex.name, category: ex.category || form.category } : {}) });
              }}
              placeholder="34"
              autoComplete="off"
              autoCapitalize="characters"
              className={cn(FIELD, "w-32 font-sign text-xl font-bold tracking-wide")}
            />
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-400">{form.kind === "number" ? "Name (optional)" : "Name"}</span>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={form.kind === "number" ? "Computer Science" : "Central park, Food court…"}
            autoComplete="off"
            className={FIELD}
          />
        </label>
        <div>
          <span className="mb-1.5 block text-xs text-zinc-400">Kind</span>
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                aria-pressed={form.category === k.id}
                onClick={() => setForm({ ...form, category: k.id })}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm transition-colors",
                  form.category === k.id ? "bg-amber-400 font-medium text-zinc-950" : "bg-white/[0.06] text-zinc-200 ring-1 ring-inset ring-white/10 hover:bg-white/10",
                )}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={form.hidden} onChange={(e) => setForm({ ...form, hidden: e.target.checked })} className="h-4 w-4 accent-amber-400" />
          Hide it from students
        </label>
        {clash && (
          <p className="text-amber-200">
            {placedAt(clash)
              ? `${clash.block_no} is already on the map (${clash.name}). Saving moves it here.`
              : `${clash.block_no} is in the list (${clash.name}) but not on the map. Saving puts it here.`}
          </p>
        )}
        {!form.at && <p className="text-zinc-400">This one isn't on the map. Use Move afterwards to put it on a building.</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="h-11 flex-1 rounded-xl bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300 disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => setForm(null)} className="h-11 rounded-xl bg-white/10 px-4 font-semibold text-white hover:bg-white/15">Cancel</button>
        </div>
      </form>
    );
  } else if (spot) {
    body = (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-base font-medium text-white">{building ? "This building" : "This spot"}</p>
          <button type="button" onClick={c.clearEditSpot} aria-label="Clear the selection" className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        {here.length ? (
          <ul className="space-y-1.5">{here.map(row)}</ul>
        ) : baseLabel ? (
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.04] p-2 pl-3 ring-1 ring-inset ring-white/10">
            <span className="min-w-0 flex-1 text-zinc-300">Base map label: <span className="font-medium text-white">{baseLabel}</span></span>
            <button type="button" onClick={hideBase} disabled={busy} className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-sm font-medium text-white hover:bg-white/15 disabled:opacity-50">
              <EyeOff className="h-4 w-4" aria-hidden /> Hide
            </button>
          </div>
        ) : (
          <p className="text-zinc-400">{building ? "No number or name on this building yet." : "Nothing is named here yet."}</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={addNumber} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300">
            <Plus className="h-4 w-4" aria-hidden /> Add a number
          </button>
          <button type="button" onClick={addName} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-white/10 font-semibold text-white hover:bg-white/15">
            <Plus className="h-4 w-4" aria-hidden /> Add a name
          </button>
        </div>
      </div>
    );
  } else {
    const chip = (on: boolean) => cn(
      "rounded-full px-3 py-1.5 text-sm transition-colors",
      on ? "bg-amber-400 font-medium text-zinc-950" : "bg-white/[0.06] text-zinc-200 ring-1 ring-inset ring-white/10 hover:bg-white/10",
    );
    body = (
      <div className="space-y-3">
        <p className="text-zinc-300">Tap a building, a park or any spot on the map to add a number or a name there. Tap a label to change it.</p>
        {(hiddenRows.length > 0 || unplaced.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {hiddenRows.length > 0 && (
              <button type="button" aria-pressed={list === "hidden"} onClick={() => setList(list === "hidden" ? null : "hidden")} className={chip(list === "hidden")}>
                Hidden ({hiddenRows.length})
              </button>
            )}
            {unplaced.length > 0 && (
              <button type="button" aria-pressed={list === "unplaced"} onClick={() => setList(list === "unplaced" ? null : "unplaced")} className={chip(list === "unplaced")}>
                Not on the map ({unplaced.length})
              </button>
            )}
          </div>
        )}
        {list && <ul className="space-y-1.5">{(list === "hidden" ? hiddenRows : unplaced).map(row)}</ul>}
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:pb-5">
      <section
        aria-label={stats ? "Visitors" : "Edit the map"}
        className={cn(
          "pointer-events-auto mx-auto flex w-full max-w-md flex-col overflow-hidden rounded-3xl text-sm text-zinc-100",
          stats ? "max-h-[min(86svh,760px)]" : "max-h-[min(62svh,560px)]",
          GLASS,
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400/15 text-amber-300">
            {stats ? <BarChart3 className="h-4 w-4" aria-hidden /> : <Pencil className="h-4 w-4" aria-hidden />}
          </span>
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-white">{stats ? "Visitors" : "Edit the map"}</h2>
          {pass && (
            <button
              type="button"
              onClick={() => { setStats(!stats); setNote(null); setForm(null); setMoving(null); }}
              aria-pressed={stats}
              aria-label={stats ? "Back to editing the map" : "Visitor numbers"}
              title={stats ? "Back to editing the map" : "Visitor numbers"}
              className={cn(
                "flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors",
                stats ? "bg-amber-400 text-zinc-950 hover:bg-amber-300" : "text-zinc-300 hover:bg-white/10 hover:text-white",
              )}
            >
              {stats ? <Pencil className="h-4 w-4" aria-hidden /> : <BarChart3 className="h-4 w-4" aria-hidden />}
              {stats ? "Map" : "Visitors"}
            </button>
          )}
          {pass && (
            <button type="button" onClick={lock} aria-label="Lock editing on this device" title="Lock editing on this device" className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white">
              <Lock className="h-4 w-4" />
            </button>
          )}
          <button type="button" onClick={finish} className="h-9 rounded-full bg-white/10 px-4 text-sm font-semibold text-white hover:bg-white/15">Done</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {body}
          {note && <p role="status" className={cn("mt-3", note.bad ? "text-rose-300" : "text-emerald-300")}>{note.text}</p>}
        </div>
      </section>
    </div>
  );
}
