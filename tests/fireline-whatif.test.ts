import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Node executes TypeScript directly; app imports use bundler resolution.
import { applyFireLines } from "../lib/fireline-whatif.ts";
import type { WhatIfCell } from "../lib/fireline-whatif";

// A 7 x 5 grid of unit squares; the fire is burning in column 0.
function grid(): WhatIfCell[] {
  const cells: WhatIfCell[] = [];
  for (let x = 0; x < 7; x++) for (let y = 0; y < 5; y++) cells.push({ id: `${x}-${y}`, polygon: [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]], p: 0.4, previous: x === 0 ? 1 : 0 });
  return cells;
}
const W = { near: -0.2, mid: -1, far: -2, cutOff: -0.7 };
const odds = (p: number, w: number) => 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + w)));
const at = (cells: { id: string; p: number }[], id: string) => cells.find(c => c.id === id)!.p;

test("no lines leaves every score unchanged", () => {
  const r = applyFireLines(grid(), [], W);
  assert.equal(r.lowered + r.cutOff, 0);
  assert.ok(r.cells.every(c => c.p === 0.4));
});

test("a line across the whole grid cuts off the far side", () => {
  const r = applyFireLines(grid(), [[[3, -1], [3, 6]]], W);
  assert.equal(at(r.cells, "1-2"), 0.4, "near side unchanged");
  assert.ok(Math.abs(at(r.cells, "5-2") - odds(0.4, W.mid + W.cutOff)) < 1e-12, "far side re-scored as cut off, 3-5 squares out");
  assert.equal(r.cutOff, 4 * 5);
  assert.equal(at(r.cells, "0-2"), 0.4, "burning squares are never lowered");
});

test("a short line lowers squares behind it less than a full cut, and leaves squares beside it alone", () => {
  const r = applyFireLines(grid(), [[[3, 1.2], [3, 3.8]]], W);
  const behind = at(r.cells, "3-2");
  assert.ok(Math.abs(behind - odds(0.4, W.mid)) < 1e-12, "re-scored as behind a line, not cut off");
  assert.equal(at(r.cells, "5-0"), 0.4, "a square the fire reaches without a detour is unchanged");
  assert.equal(r.cutOff, 0);
  assert.ok(r.lowered > 0);
});

test("scores are never raised, even with positive fitted weights", () => {
  const before = grid(), r = applyFireLines(before, [[[2, 0.5], [4.5, 4.5]], [[5, -1], [5, 2.5]]], { near: 0.4, mid: -1, far: -2, cutOff: 0.3 });
  r.cells.forEach((c, i) => assert.ok(c.p <= before[i].p));
});
