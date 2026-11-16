// Turns satellite detections (375 m pixels) into a drawable fire: where the flame fronts run, where the ground is burned, and where to stand to look at it.
// The detections fix where fire is; the exact line between neighbouring detections is an interpolation.
// Small deterministic generator (kept local so this module has no imports and can be unit-tested directly).
function seeded(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export interface Det { x: number; z: number; frp: number; age: number }
export interface Emitter { x: number; z: number; w: number; h: number; wd: number; inten: number; seed: number; kind: number }
export interface FireLayout { emitters: Emitter[]; active: Det[]; earlier: Det[]; focus: [number, number]; side: number; totalFrp: number }

const LINK = 640; // metres: neighbouring VIIRS pixels (375 m) including diagonals

/** `wind` is the unit vector the wind blows toward. */
export function layoutFire(dets: Det[], wind: [number, number], cap: number): FireLayout {
  const minAge = dets.reduce((m, d) => Math.min(m, d.age), Infinity);
  const active = dets.filter(d => d.age <= minAge + 0.5), earlier = dets.filter(d => d.age > minAge + 0.5);
  const rnd = seeded(7331), [wx, wz] = wind, px = -wz, pz = wx; // p = wind rotated 90 degrees
  const cell = new Map<string, number[]>(), key = (x: number, z: number) => `${Math.floor(x / LINK)},${Math.floor(z / LINK)}`;
  active.forEach((d, i) => { const k = key(d.x, d.z); if (!cell.has(k)) cell.set(k, []); cell.get(k)!.push(i); });
  const near = (i: number) => { const d = active[i], out: number[] = [], cx = Math.floor(d.x / LINK), cz = Math.floor(d.z / LINK);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of cell.get(`${cx + a},${cz + b}`) ?? []) if (j !== i && Math.hypot(active[j].x - d.x, active[j].z - d.z) < LINK) out.push(j);
    return out; };
  const nb = active.map((_, i) => near(i));
  const along = (i: number, j: number) => (active[j].x - active[i].x) * wx + (active[j].z - active[i].z) * wz;
  const across = (i: number, j: number) => (active[j].x - active[i].x) * px + (active[j].z - active[i].z) * pz;
  // head: nothing burning in the cone straight downwind; back: nothing in the cone straight upwind. (A cone, because pixel rows are staggered.)
  const inCone = (i: number, j: number, sign: number) => { const al = along(i, j) * sign; return al > 150 && Math.abs(across(i, j)) < al * 0.85; };
  const head = active.map((_, i) => !nb[i].some(j => inCone(i, j, 1))), back = active.map((_, i) => !head[i] && !nb[i].some(j => inCone(i, j, -1)));
  const sideOpen = (i: number, sign: number) => !nb[i].some(j => { const ac = across(i, j) * sign; return ac > 150 && Math.abs(along(i, j)) < ac * 0.85; });
  // Connected groups of detections: fronts are only joined within one group.
  const comp = active.map(() => -1); let nc = 0; active.forEach((_, i) => { if (comp[i] >= 0) return; const st = [i]; comp[i] = nc; while (st.length) { const a = st.pop()!; for (const b of nb[a]) if (comp[b] < 0) { comp[b] = nc; st.push(b); } } nc++; });
  const heads = active.map((_, i) => i).filter(i => head[i]);
  const edges = new Map<string, { i: number; j: number; kind: number }>();
  const link = (i: number, j: number, kind: number) => { const k = i < j ? `${i}-${j}` : `${j}-${i}`, e = edges.get(k); if (!e || kind > e.kind) edges.set(k, { i, j, kind }); };
  const nearestSide = (i: number, pool: number[], f: (i: number, j: number) => number, sign: number) => { let best = -1, bd = Infinity; for (const j of pool) { if (f(i, j) * sign <= 60) continue; const dd = Math.hypot(active[j].x - active[i].x, active[j].z - active[i].z); if (dd < bd) { bd = dd; best = j; } } return best; };
  active.forEach((_, i) => {
    if (head[i]) for (const sgn of [1, -1]) { const j = nearestSide(i, heads.filter(q => q !== i && comp[q] === comp[i] && Math.hypot(active[q].x - active[i].x, active[q].z - active[i].z) < 1150), across, sgn); if (j >= 0) link(i, j, 3); else { const k = nearestSide(i, nb[i], across, sgn); if (k >= 0 && along(i, k) < 0) link(i, k, 2); } }
    else if (back[i]) for (const sgn of [1, -1]) { const j = nearestSide(i, nb[i].filter(q => back[q]), across, sgn); if (j >= 0) link(i, j, 1); }
    else if (sideOpen(i, 1) || sideOpen(i, -1)) for (const sgn of [1, -1]) { const j = nearestSide(i, nb[i].filter(q => sideOpen(q, 1) || sideOpen(q, -1) || head[q] || back[q]), along, sgn); if (j >= 0) link(i, j, 2); }
  });
  // Where to look from: the head detection with the most fire around it.
  const totalFrp = active.reduce((s, d) => s + Math.max(d.frp, 1), 0);
  let fi = 0, fs = -1;
  active.forEach((d, i) => { let s = Math.sqrt(Math.max(d.frp, 1)); for (const o of active) { const dd = Math.hypot(o.x - d.x, o.z - d.z); if (dd < 2500 && dd > 0) s += Math.sqrt(Math.max(o.frp, 1)) * (1 - dd / 2500); } if (head[i] && nb[i].length) s *= 4; if (s > fs) { fs = s; fi = i; } });
  const F = active[fi] ?? { x: 0, z: 0, frp: 0, age: 0 };
  let left = 0, right = 0; for (const o of active) { const a = (o.x - F.x) * px + (o.z - F.z) * pz; if (Math.hypot(o.x - F.x, o.z - F.z) < 3000) { if (a > 150) right++; else if (a < -150) left++; } }
  const side = right <= left ? 1 : -1;
  const spacingAt = (x: number, z: number) => { const d = Math.hypot(x - F.x, z - F.z); return d < 1200 ? 4 : d < 4000 ? 11 : d < 12000 ? 28 : 70; };
  const emitters: Emitter[] = [];
  const add = (x: number, z: number, kind: number, frp: number, sp: number) => {
    const power = Math.min(2.2, 0.55 + Math.sqrt(Math.max(frp, 1)) / 7), hBase = kind === 3 ? 5.5 + 10 * rnd() * rnd() : kind === 2 ? 2 + 3.5 * rnd() * rnd() : kind === 1 ? 0.8 + 1.6 * rnd() : 0.7 + 2.2 * rnd() * rnd();
    const h = hBase * (0.7 + 0.5 * power) * (1 + (sp > 6 ? 0.25 : 0)), inten = (kind >= 2 ? 1 : 0.6) * (0.75 + 0.5 * rnd());
    emitters.push({ x, z, w: sp / 5 * (kind === 3 ? 1.5 : kind === 2 ? 0.8 : 0.35) * power, h, wd: h * (0.75 + 0.5 * rnd()), inten, seed: rnd(), kind });
    if (sp <= 5 && kind >= 2) for (let k = 0; k < 2; k++) { const back2 = 2 + rnd() * 11, hh = h * (0.35 + 0.4 * rnd()); emitters.push({ x: x - wx * back2 + (rnd() - 0.5) * 4, z: z - wz * back2 + (rnd() - 0.5) * 4, w: 0, h: hh, wd: hh * (0.8 + 0.6 * rnd()), inten: inten * 0.8, seed: rnd(), kind }); }
  };
  // Round off the zig-zag that comes from joining pixel centres on the satellite's grid.
  let sm = active.map(d => ({ x: d.x, z: d.z })); const links = active.map(() => [] as number[]); for (const e of edges.values()) { links[e.i].push(e.j); links[e.j].push(e.i); }
  for (let it = 0; it < 3; it++) sm = sm.map((p, i) => { const l = links[i]; if (l.length < 2) return p; let ax = 0, az = 0; for (const j of l) { ax += sm[j].x; az += sm[j].z; } return { x: p.x * 0.45 + ax / l.length * 0.55, z: p.z * 0.45 + az / l.length * 0.55 }; });
  for (const { i, j, kind } of edges.values()) {
    const a = { ...active[i], ...sm[i] }, b = { ...active[j], ...sm[j] }, len = Math.hypot(b.x - a.x, b.z - a.z), nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len, sp = spacingAt((a.x + b.x) / 2, (a.z + b.z) / 2), n = Math.max(2, Math.ceil(len / sp));
    const p1 = rnd() * 6.28, p2 = rnd() * 6.28, amp = 22 + rnd() * 26, gap = rnd() * 6.28;
    for (let k = 0; k < n; k++) { const t = (k + rnd()) / n;
      if (Math.sin(t * 9 + gap) + Math.sin(t * 23 + gap * 2) * 0.6 < -1.05) continue; // breaks in the line
      const wob = (Math.sin(t * Math.PI * 2 + p1) * 0.6 + Math.sin(t * Math.PI * 5 + p2) * 0.3) * amp * Math.sin(t * Math.PI), jit = (rnd() - 0.5) * 3;
      add(a.x + (b.x - a.x) * t + nx * (wob + jit), a.z + (b.z - a.z) * t + nz * (wob + jit), kind, a.frp + (b.frp - a.frp) * t, sp); }
  }
  const linked = new Set<number>(); for (const e of edges.values()) { linked.add(e.i); linked.add(e.j); }
  active.forEach((d, i) => {
    const sp = spacingAt(d.x, d.z);
    if (!nb[i].length) { const R = 55 + rnd() * 70, n = Math.max(6, Math.round(2 * Math.PI * R * 0.6 / sp)), a0 = Math.atan2(wz, wx); // lone detection: a small arc, open upwind
      for (let k = 0; k < n; k++) { const a = a0 + (k / n - 0.5) * Math.PI * 1.3 + (rnd() - 0.5) * 0.1; add(d.x + Math.cos(a) * R * (0.85 + 0.3 * rnd()), d.z + Math.sin(a) * R * (0.85 + 0.3 * rnd()), 2, d.frp, sp); } }
    else if (!linked.has(i) || (!head[i] && !back[i])) { const n = Math.round((sp <= 5 ? 16 : 5) * (0.6 + rnd())); // inside the fire: scattered burning
      for (let k = 0; k < n; k++) { const a = rnd() * 6.28, r = Math.sqrt(rnd()) * 190; add(d.x + Math.cos(a) * r, d.z + Math.sin(a) * r, 0, d.frp, sp); } }
  });
  if (emitters.length > cap) { // keep everything close to the view, thin the rest
    const d = (e: Emitter) => Math.hypot(e.x - F.x, e.z - F.z), far = emitters.filter(e => d(e) >= 1200), nearE = emitters.filter(e => d(e) < 1200), keep = Math.max(0, cap - nearE.length) / Math.max(1, far.length);
    emitters.length = 0; emitters.push(...nearE.slice(0, cap)); for (const e of far) if (rnd() < keep) { e.w /= Math.max(keep, 0.05); emitters.push(e); }
  }
  return { emitters, active, earlier, focus: [F.x, F.z], side, totalFrp };
}
