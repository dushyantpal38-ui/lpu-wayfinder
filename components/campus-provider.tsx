"use client";

import * as React from "react";
import {
  buildBlocks, loadCampus, placeBlocks,
  type Block, type DbBlock, type DbLabel, type FC, type Pt,
} from "@/lib/campus";
import { fetchBlocks, fetchLabels } from "@/lib/supabase";
import { readAdminFlag } from "@/lib/admin";

type CampusState = {
  fc: FC | null; // campus with the saved labels on the buildings
  blocks: Block[]; // the list shown on the page (hidden labels only while the owner edits)
  db: DbBlock[]; // every saved label, hidden ones included
  labels: DbLabel[]; // free text names (not used by the editor)
  loading: boolean;
  error: string | null;
  reload: () => void;
  refreshBlocks: () => Promise<void>; // fetch the saved labels again (after the owner saves)
  // Owner editing. Only shown with ?admin=1; saving needs the owner passcode.
  admin: boolean;
  editing: boolean;
  setEditing: (on: boolean) => void;
  editSpot: { at: Pt; t: number } | null; // the last spot the owner tapped while editing
  onEditTap: (at: Pt) => void;
  clearEditSpot: () => void;
};

const Ctx = React.createContext<CampusState>({
  fc: null, blocks: [], db: [], labels: [], loading: true, error: null, reload: () => {}, refreshBlocks: async () => {},
  admin: false, editing: false, setEditing: () => {}, editSpot: null, onEditTap: () => {}, clearEditSpot: () => {},
});

export function useCampus() {
  return React.useContext(Ctx);
}

export function CampusProvider({ children }: { children: React.ReactNode }) {
  const [base, setBase] = React.useState<FC | null>(null);
  const [db, setDb] = React.useState<DbBlock[]>([]);
  const [labels, setLabels] = React.useState<DbLabel[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const [admin, setAdmin] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editSpot, setEditSpot] = React.useState<{ at: Pt; t: number } | null>(null);

  React.useEffect(() => { setAdmin(readAdminFlag()); }, []);

  React.useEffect(() => {
    let alive = true;
    loadCampus(tick > 0)
      .then((fc) => { if (alive) { setBase(fc); setError(null); } })
      .catch((e: unknown) => { if (alive) setError("Could not load the campus map (" + (e instanceof Error ? e.message : String(e)) + "). Check your internet and reload."); });
    fetchBlocks().then((r) => { if (alive) setDb(r); }).catch(() => {});
    fetchLabels().then((r) => { if (alive) setLabels(r); }).catch(() => {});
    return () => { alive = false; };
  }, [tick]);

  const refreshBlocks = React.useCallback(async () => {
    try { setDb(await fetchBlocks()); } catch { /* keep what is shown */ }
  }, []);
  const onEditTap = React.useCallback((at: Pt) => setEditSpot({ at, t: Date.now() }), []);
  const clearEditSpot = React.useCallback(() => setEditSpot(null), []);

  const value = React.useMemo<CampusState>(() => {
    const fc = base ? placeBlocks(base, db) : null;
    // The block list comes from the database, so it still shows when the map could not load.
    const all = buildBlocks(fc ?? { type: "FeatureCollection", features: [] }, db);
    return {
      fc,
      blocks: editing ? all : all.filter((b) => !b.hidden),
      db,
      labels,
      loading: !base && !error,
      error,
      reload: () => setTick((t) => t + 1),
      refreshBlocks,
      admin, editing, setEditing, editSpot, onEditTap, clearEditSpot,
    };
  }, [base, db, labels, error, admin, editing, editSpot, refreshBlocks, onEditTap, clearEditSpot]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
