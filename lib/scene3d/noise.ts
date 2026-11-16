// Deterministic tileable noise, generated once on the CPU and uploaded as textures.
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Tileable 3D value-noise lattice of `period` cells. */
function lattice3(period: number, seed: number) {
  const r = rng(seed), g = new Float32Array(period ** 3); for (let i = 0; i < g.length; i++) g[i] = r();
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = fade(x - xi), fy = fade(y - yi), fz = fade(z - zi);
    const w = (a: number) => ((a % period) + period) % period, at = (a: number, b: number, c: number) => g[(w(c) * period + w(b)) * period + w(a)];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(l(l(at(xi, yi, zi), at(xi + 1, yi, zi), fx), l(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), fx), fy), l(l(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), fx), l(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), fx), fy), fz);
  };
}
/** Tileable 3D Worley (cellular) noise: 1 at feature points, falling to 0 between them. */
function worley3(cells: number, seed: number) {
  const r = rng(seed), pts = new Float32Array(cells ** 3 * 3); for (let i = 0; i < pts.length; i++) pts[i] = r();
  const w = (a: number) => ((a % cells) + cells) % cells;
  return (x: number, y: number, z: number) => { // x,y,z in [0,1)
    const px = x * cells, py = y * cells, pz = z * cells, cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz); let best = 9;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const o = ((w(cz + k) * cells + w(cy + j)) * cells + w(cx + i)) * 3, dx = cx + i + pts[o] - px, dy = cy + j + pts[o + 1] - py, dz = cz + k + pts[o + 2] - pz, d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    return Math.max(0, 1 - Math.sqrt(best));
  };
}
/** RGBA volume, tileable. R: billowy low-frequency shape (value fbm x inverted worley), G: mid worley, B: fine worley, A: smooth fbm. */
export function noiseVolume(size = 64): Uint8Array {
  const a1 = lattice3(4, 11), a2 = lattice3(8, 12), a3 = lattice3(16, 13), a4 = lattice3(32, 14);
  const w1 = worley3(3, 21), w2 = worley3(6, 22), w3 = worley3(12, 23), w4 = worley3(24, 24);
  const out = new Uint8Array(size ** 3 * 4), c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let z = 0, o = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++, o += 4) {
    const u = x / size, v = y / size, t = z / size;
    const fbm = a1(u * 4, v * 4, t * 4) * 0.5 + a2(u * 8, v * 8, t * 8) * 0.27 + a3(u * 16, v * 16, t * 16) * 0.15 + a4(u * 32, v * 32, t * 32) * 0.08;
    const wl = w1(u, v, t) * 0.6 + w2(u, v, t) * 0.28 + w3(u, v, t) * 0.12, wm = w2(u, v, t) * 0.6 + w3(u, v, t) * 0.28 + w4(u, v, t) * 0.12;
    // Each channel is stretched so its values fill 0..1 (5th to 95th percentile roughly 0.06 to 0.92).
    out[o] = c(((fbm * 0.55 + wl * 0.75 - 0.12) * 1.25 - 0.38) / 0.52); out[o + 1] = c((wm * 1.1 - 0.28) / 0.5); out[o + 2] = c((w3(u, v, t) * 0.55 + w4(u, v, t) * 0.5 - 0.25) / 0.5); out[o + 3] = c((fbm * 1.25 - 0.1 - 0.23) / 0.56);
  }
  return out;
}
/** RGBA tile of 2D noise at four frequencies, tileable. */
export function noiseTile(size = 256): Uint8Array {
  const L = [lattice3(8, 31), lattice3(16, 32), lattice3(32, 33), lattice3(64, 34), lattice3(128, 35)];
  const f = (x: number, y: number, k: number, oct: number) => { let s = 0, a = 0.5, n = 0; for (let i = 0; i < oct && k + i < L.length; i++) { const p = 8 << (k + i); s += L[k + i](x * p, y * p, 0.37 + i) * a; n += a; a *= 0.5; } return s / n; };
  const out = new Uint8Array(size * size * 4), c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0, o = 0; y < size; y++) for (let x = 0; x < size; x++, o += 4) {
    const u = x / size, v = y / size;
    out[o] = c((f(u, v, 0, 5) - 0.5) * 1.7 + 0.5); out[o + 1] = c((f(u + 0.31, v + 0.17, 1, 4) - 0.5) * 1.8 + 0.5); out[o + 2] = c((f(u + 0.63, v + 0.41, 2, 3) - 0.5) * 1.9 + 0.5); out[o + 3] = c((f(u + 0.11, v + 0.77, 3, 2) - 0.5) * 2 + 0.5);
  }
  return out;
}
/** Small deterministic generator for placing things. */
export const seeded = rng;
