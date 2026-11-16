// Line-aware step: re-scores squares when a fire line (or other tactic) stands between them and the fire.
//
// 1. Fire is assumed to travel square to square from the squares burning now. A line blocks any step
//    that crosses it. Each square's shortest route from the fire is found with and without the lines.
// 2. A square whose route got longer is "behind a line"; one with no route left is "cut off".
// 3. Its new score comes from a small fitted model (lib/fireline-model.ts, trained by
//    scripts/ml/fireline_model.py on real completed crew lines from 2018-2019 fires):
//        new score = sigmoid(logit(model score) + weight[near | mid | far] (+ weight[cutOff]))
//    where near/mid/far is how many squares the square was from the fire (1-2, 3-5, 6+).
// Squares in the clear keep the frozen model's score exactly. Scores are never raised: a positive
// fitted weight would reflect crews building lines where fire is already heading, not lines causing fire.
// @ts-expect-error -- Native Node TypeScript tests require explicit extensions.
import { FIRELINE_MODEL } from "./fireline-model.ts";
export type WhatIfCell = { id: string; polygon: number[][]; p: number; previous: number; observed?: number };
export type FireLine = [number, number][]; // [lon, lat] points, in drawing order
export type LineWeights = { near: number; mid: number; far: number; cutOff: number };

type P = [number, number];
const cross = (a: P, b: P, c: P) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function centre(polygon: number[][]): P {
  const n = Math.max(1, Math.min(4, polygon.length));
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += polygon[i][0]; y += polygon[i][1]; }
  return [x / n, y / n];
}

export function applyFireLines<T extends WhatIfCell>(cells: T[], lines: FireLine[], weights: LineWeights = FIRELINE_MODEL.weights as LineWeights): { cells: (T & { p0?: number })[]; lowered: number; cutOff: number } {
  const segments: [P, P][] = [];
  for (const line of lines) for (let i = 1; i < line.length; i++) segments.push([line[i - 1], line[i]]);
  const grid = cells.map(cell => { const m = /^(-?\d+)-(-?\d+)$/.exec(cell.id); return m ? [Number(m[1]), Number(m[2])] : null; });
  const sources = cells.map((cell, i) => cell.previous ? i : -1).filter(i => i >= 0);
  if (!segments.length || !sources.length || grid.some(g => g === null)) return { cells, lowered: 0, cutOff: 0 };

  const index = new Map<string, number>();
  grid.forEach((g, i) => index.set(`${g![0]},${g![1]}`, i));
  const centres = cells.map(cell => centre(cell.polygon));
  const blocked = (a: number, b: number) => segments.some(([c, d]) => segmentsCross(centres[a], centres[b], c, d));

  function distances(useLines: boolean): Float64Array {
    const dist = new Float64Array(cells.length).fill(Infinity), done = new Uint8Array(cells.length);
    for (const s of sources) dist[s] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = 1;
      const [gx, gy] = grid[u]!;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const v = index.get(`${gx + dx},${gy + dy}`);
        if (v === undefined || done[v]) continue;
        const step = dx && dy ? Math.SQRT2 : 1;
        if (dist[u] + step >= dist[v] || (useLines && blocked(u, v))) continue;
        dist[v] = dist[u] + step;
      }
    }
    return dist;
  }

  const open = distances(false), held = distances(true);
  let lowered = 0, cutOff = 0;
  const out = cells.map((cell, i) => {
    if (cell.previous || !Number.isFinite(open[i]) || held[i] <= open[i] + 1e-9) return cell;
    const cut = !Number.isFinite(held[i]);
    if (cut) cutOff++; else lowered++;
    const band = open[i] <= 2.5 ? weights.near : open[i] <= 5.5 ? weights.mid : weights.far;
    const p = Math.min(1 - 1e-6, Math.max(1e-6, cell.p));
    const rescored = 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + band + (cut ? weights.cutOff : 0))));
    return { ...cell, p: Math.min(cell.p, rescored), p0: cell.p };
  });
  return { cells: out, lowered, cutOff };
}
