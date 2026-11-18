"use client";

import * as React from "react";
import { isOwnerDevice, readAdminFlag } from "@/lib/admin";

// Anonymous visit counting for the owner's stats.
// - One count per open of the site (per browser tab), sent to our own server (/api/visit), never to a third party.
// - The phone gets a random id so the owner can tell new users from returning ones. No name, no account.
// - If the student has ALREADY allowed location for the map, the position is sent once; the server keeps only
//   the nearest block and throws the coordinates away. This never asks for location by itself.
// - Not counted: the owner's own devices, ?admin=1, automated browsers, and browsers that send
//   "Do Not Track" / Global Privacy Control.

const VISITOR_KEY = "lpuVisitor";
const TAB_KEY = "lpuVisitThisTab";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function visitorId(): string | null {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id || !UUID.test(id)) {
      id = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (ch) =>
          (Number(ch) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(ch) / 4)))).toString(16));
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return null; // storage blocked: don't count
  }
}

function deviceKind(): "phone" | "tablet" | "computer" {
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (/iPad|Tablet/i.test(ua) || iPadOS || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return "phone";
  return "computer";
}

function optedOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; webdriver?: boolean };
  return !!nav.webdriver || nav.globalPrivacyControl === true || nav.doNotTrack === "1";
}

async function post(body: Record<string, unknown>): Promise<{ id?: number | null } | null> {
  try {
    const r = await fetch("/api/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
      cache: "no-store",
    });
    return r.ok ? ((await r.json()) as { id?: number | null }) : null;
  } catch {
    return null;
  }
}

/** Sends the place once, if location is (or becomes) allowed for this site within 25 minutes. */
async function sendPlaceWhenAllowed(id: number, v: string) {
  if (!("geolocation" in navigator) || !navigator.permissions?.query) return;
  let status: PermissionStatus;
  try { status = await navigator.permissions.query({ name: "geolocation" as PermissionName }); } catch { return; }

  let done = false;
  let tries = 0;
  const stopAt = Date.now() + 25 * 60 * 1000;
  const attempt = () => {
    if (done || Date.now() > stopAt) return;
    tries++;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (done) return;
        if (pos.coords.accuracy > 150) { if (tries < 3) setTimeout(attempt, 20000); return; } // GPS still warming up
        done = true;
        void post({ t: "place", id, v, lng: +pos.coords.longitude.toFixed(5), lat: +pos.coords.latitude.toFixed(5) });
      },
      () => { /* denied or no fix: no place for this visit */ },
      { enableHighAccuracy: true, maximumAge: 60000, timeout: 20000 },
    );
  };
  if (status.state === "granted") { setTimeout(attempt, 4000); return; }
  if (status.state === "prompt") {
    status.onchange = () => {
      if (status.state === "granted") { status.onchange = null; setTimeout(attempt, 3000); }
      if (status.state === "denied") status.onchange = null;
    };
  }
}

export function VisitTracker() {
  React.useEffect(() => {
    if (optedOut() || readAdminFlag() || isOwnerDevice()) return;
    try { if (sessionStorage.getItem(TAB_KEY)) return; sessionStorage.setItem(TAB_KEY, "1"); } catch { return; }
    const v = visitorId();
    if (!v) return;

    const params = new URLSearchParams(window.location.search);
    const nav = navigator as Navigator & { standalone?: boolean };
    const app = window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true;
    void post({
      t: "open",
      v,
      d: deviceKind(),
      app,
      src: (params.get("src") || params.get("utm_source") || "").slice(0, 32) || null,
    }).then((r) => { if (r && typeof r.id === "number") void sendPlaceWhenAllowed(r.id, v); });
  }, []);
  return null;
}
