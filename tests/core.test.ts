// Run with: npm test (Node 22.6+ runs TypeScript directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, findRoute } from "../lib/routing.ts";
import { pointInRing, searchBlocks, type Block, type FC, type Pt } from "../lib/campus.ts";
import { parseRoom } from "../lib/places.ts";

// One square building (about 38 x 44 m) with a road running past its south side.
const ring: Pt[] = [[75.7, 31.25], [75.7004, 31.25], [75.7004, 31.2504], [75.7, 31.2504], [75.7, 31.25]];
const fc: FC = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { kind: "building" }, geometry: { type: "Polygon", coordinates: [ring] } },
    { type: "Feature", properties: { kind: "road" }, geometry: { type: "LineString", coordinates: [[75.6996, 31.2498], [75.7002, 31.2498], [75.7008, 31.2498]] } },
  ],
};

// The building shrunk by about 1 m: a route may brush a corner, but not cut through.
const inner: Pt[] = [[75.70001, 31.25001], [75.70039, 31.25001], [75.70039, 31.25039], [75.70001, 31.25039], [75.70001, 31.25001]];

test("route goes around a building, not through it", () => {
  const from: Pt = [75.6998, 31.2502], to: Pt = [75.7006, 31.2502]; // straight line crosses the building
  const r = findRoute(buildGraph(fc), from, to);
  assert.ok(r.onRoads);
  for (let i = 1; i < r.coords.length; i++) {
    const [a, b] = [r.coords[i - 1], r.coords[i]];
    for (let t = 0; t <= 1; t += 0.05) {
      const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      assert.ok(!pointInRing(p, inner), `route passes through the building at ${p}`);
    }
  }
  assert.ok(r.metres > 76 && r.metres < 200, `odd length ${r.metres}`); // straight line is about 76 m
});

test("route to a building you are inside is empty", () => {
  const r = findRoute(buildGraph(fc), [75.7002, 31.2502], [75.7002, 31.2502], ring);
  assert.equal(r.metres, 0);
});

test("room codes", () => {
  assert.deepEqual(parseRoom("34-204"), { block: "34", room: "204" });
  assert.deepEqual(parseRoom("block 21a 105"), { block: "21A", room: "105" });
  assert.equal(parseRoom("unimall"), null);
});

test("search puts the exact number first", () => {
  const b = (num: string, name: string): Block => ({ num, name, dept: "", category: "other", aliases: [], c: null, placed: false, hidden: false });
  const blocks = [b("3", "Physiotherapy"), b("34", "Computer Science"), b("UNIMALL", "Unimall")];
  assert.deepEqual(searchBlocks(blocks, "3").map((x) => x.num), ["3", "34"]);
  assert.deepEqual(searchBlocks(blocks, "block 34").map((x) => x.num), ["34"]);
  assert.equal(searchBlocks(blocks, "uni")[0].num, "UNIMALL");
});
