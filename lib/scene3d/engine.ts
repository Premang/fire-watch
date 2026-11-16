// 3D fire view. Real: terrain shape, ground imagery, where the satellite saw fire, the wind, and the sun's position at the time of the pass.
// Simulated: the flames, smoke, embers and the exact line the fire front follows between detections.
import * as THREE from "three";
import { LocalFrame, direction, latToTile, lonToTile, sunMoon, windVector } from "./geo";
import { noiseTile, noiseVolume, seeded } from "./noise";
import { DEM_URL, HeightField, IMAGERY_URL, loadMosaic, meanColor, type Mosaic } from "./tiles";
import { layoutFire, type Det, type FireLayout } from "./fire-layout";
import * as G from "./shaders";
import type { SceneData, SceneProgress, SceneQuality, SceneView } from "./types";

const D2R = Math.PI / 180;
const QUALITY = {
  low: { grid: 320, img: [5, 6, 6, 6], smoke: 0.5, steps: 40, light: 3, trees: 9000, shrubs: 12000, grass: 22000, flames: 4500, embers: 1200, shadows: 0, hi: false },
  medium: { grid: 448, img: [6, 8, 8, 8], smoke: 0.5, steps: 60, light: 4, trees: 26000, shrubs: 40000, grass: 70000, flames: 9000, embers: 3000, shadows: 20000, hi: false },
  high: { grid: 640, img: [6, 8, 8, 10], smoke: 0.5, steps: 80, light: 5, trees: 55000, shrubs: 90000, grass: 150000, flames: 14000, embers: 5000, shadows: 45000, hi: true },
  film: { grid: 900, img: [6, 8, 10, 12], smoke: 1, steps: 130, light: 6, trees: 140000, shrubs: 240000, grass: 420000, flames: 30000, embers: 9000, shadows: 90000, hi: true },
} as const;
const IMG_ZOOMS = [11, 13, 15, 17], MERC_Z = 17, FOV = 40;
const NEAR_SIZE = 16000, FAR_SIZE = 240000, MAP = 1024, HMAP = 512;

export interface FireSceneOptions { quality?: SceneQuality; onProgress?: (p: SceneProgress) => void; assetBase?: string; fixedSize?: [number, number] }
export interface FireSceneInfo { detections: number; earlier: number; flames: number; plants: number; sunElevation: number; moonLit: number; night: boolean; plumeTopM: number; windFrom: number | null; windSpeed: number | null; imageryLevels: number; groundM: number }
export interface FireScene {
  info: FireSceneInfo;
  ground: SceneView; overview: SceneView;
  getView(): SceneView; setView(v: SceneView): void;
  /** Camera move from the ground view (u = 0) up and out to a straight-down, north-up view (u = 1). */
  flight(u: number, end?: { target: [number, number]; distance: number }, style?: { groundShare?: number; pan?: number; startDistance?: number; startPitch?: number }): SceneView;
  /** Local metres (east, south) of a longitude/latitude. */
  project(lon: number, lat: number): [number, number];
  render(timeSec: number): void;
  /** Average several renders into one frame: motion blur and anti-aliasing for recorded video. */
  renderAccumulated(views: SceneView[], times: number[]): void;
  start(): void; stop(): void; resize(): void; dispose(): void;
  attachControls(onChange?: () => void): () => void;
  /** Set a named shader parameter on every material that has it (for tuning). */
  tune(name: string, value: number): void;
}
type Vec3 = [number, number, number];
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** Half-float RGBA texture with a hand-built mip chain (so blurred look-ups work on every WebGL2 device). */
function floatMapTexture(data: Float32Array, size: number) {
  const mips: { data: Uint16Array; width: number; height: number }[] = []; let cur = data, s = size;
  for (;;) {
    const half = new Uint16Array(cur.length); for (let i = 0; i < cur.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.min(cur[i], 60000));
    mips.push({ data: half, width: s, height: s }); if (s === 1) break;
    const n = s >> 1, next = new Float32Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (let c = 0; c < 4; c++) { const o = ((y * 2) * s + x * 2) * 4 + c; next[(y * n + x) * 4 + c] = (cur[o] + cur[o + 4] + cur[o + s * 4] + cur[o + s * 4 + 4]) * 0.25; }
    cur = next; s = n;
  }
  const t = new THREE.DataTexture(mips[0].data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mipmaps = mips as unknown as THREE.DataTexture["mipmaps"]; t.generateMipmaps = false; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  return t;
}
function splat(map: Float32Array, size: number, rect: [number, number, number], ch: number, x: number, z: number, sigma: number, amp: number) {
  const k = size / rect[2], cx = (x - rect[0]) * k - 0.5, cz = (z - rect[1]) * k - 0.5, sp = Math.max(sigma * k, 0.6), r = Math.ceil(sp * 3);
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(size - 1, Math.ceil(cx + r)), z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(size - 1, Math.ceil(cz + r)), inv = 1 / (2 * sp * sp);
  for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) { const d = (i - cx) ** 2 + (j - cz) ** 2; map[(j * size + i) * 4 + ch] += amp * Math.exp(-d * inv); }
}

export async function createFireScene(canvas: HTMLCanvasElement, data: SceneData, opts: FireSceneOptions = {}): Promise<FireScene> {
  const quality = opts.quality ?? "medium", q = QUALITY[quality], base = opts.assetBase ?? "/scene3d";
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: quality === "film" });
  const gl = renderer.getContext();
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) { renderer.dispose(); throw new Error("This device's graphics do not support the 3D view."); }
  renderer.autoClear = true; renderer.setClearColor(0x000000, 1);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ---------- where, when, wind ----------
  const windTo = data.wind ? windVector(data.wind.dirFrom) : ([1, 0] as [number, number]), windSpeed = Math.max(1.5, Math.min(25, data.wind?.speed ?? 3));
  const fires = data.fires.filter(f => Number.isFinite(f.lat) && Number.isFinite(f.lon));
  const toDets = (fr: LocalFrame): Det[] => fires.map(f => ({ x: fr.x(f.lon), z: fr.z(f.lat), frp: f.frp || 0, age: f.ageHours }));
  let frame = new LocalFrame(data.center.lat, data.center.lon);
  let fire: FireLayout = layoutFire(toDets(frame), windTo, q.flames);
  if (fire.active.length) { frame = new LocalFrame(frame.lat(fire.focus[1]), frame.lon(fire.focus[0])); fire = layoutFire(toDets(frame), windTo, q.flames); }
  const date = new Date(data.timeUTC), sky = sunMoon(Number.isNaN(date.getTime()) ? new Date() : date, frame.lat0, frame.lon0);

  // ---------- tiles ----------
  const tileTotal = 25 + 36 + q.img.reduce((s, n) => s + n * n, 0); let tileDone = 0;
  const tick = () => { tileDone++; opts.onProgress?.({ stage: "Loading terrain and imagery", done: tileDone, total: tileTotal }); };
  const farC: [number, number] = [windTo[0] * 60000, windTo[1] * 60000];
  const [farM, midM, ...imgs] = await Promise.all([
    loadMosaic(9, frame.lat(farC[1]), frame.lon(farC[0]), 5, 5, DEM_URL, tick), loadMosaic(12, frame.lat0, frame.lon0, 6, 6, DEM_URL, tick),
    ...IMG_ZOOMS.map((z, i) => loadMosaic(z, frame.lat0, frame.lon0, q.img[i], q.img[i], IMAGERY_URL, tick, true)),
  ]);
  opts.onProgress?.({ stage: "Building the landscape", done: 0, total: 1 });
  const far = new HeightField(farM), mid = new HeightField(midM);
  const ground = (x: number, z: number) => {
    const lon = frame.lon(x), lat = frame.lat(z), f = far.locate(lon, lat), hf = f ? far.at(f[0], f[1]) : far.min, m = mid.locate(lon, lat);
    if (!m) return hf; const w = mid.weight(m[0], m[1]), hm = mid.at(m[0], m[1]); return w >= 1 ? hm : hf + (hm - hf) * w;
  };
  const levels = imgs.filter(m => m.missing < m.nx * m.ny * 0.4);
  if (!levels.length) throw new Error("Ground imagery could not be loaded for this place.");

  // ---------- shared textures ----------
  const noiseTex = new THREE.DataTexture(noiseTile(256), 256, 256, THREE.RGBAFormat, THREE.UnsignedByteType);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping; noiseTex.minFilter = THREE.LinearMipmapLinearFilter; noiseTex.magFilter = THREE.LinearFilter; noiseTex.generateMipmaps = true; noiseTex.needsUpdate = true;
  const vol = new THREE.Data3DTexture(noiseVolume(64), 64, 64, 64); vol.format = THREE.RGBAFormat; vol.type = THREE.UnsignedByteType; vol.minFilter = vol.magFilter = THREE.LinearFilter; vol.wrapS = vol.wrapT = vol.wrapR = THREE.RepeatWrapping; vol.needsUpdate = true;
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); blank.needsUpdate = true;

  // ---------- fire maps: r smoke source, g fire light, b burned ground, a still hot ----------
  const rect0: [number, number, number] = [-NEAR_SIZE / 2, -NEAR_SIZE / 2, NEAR_SIZE], rect1: [number, number, number] = [farC[0] - FAR_SIZE / 2, farC[1] - FAR_SIZE / 2, FAR_SIZE];
  const e0 = new Float32Array(MAP * MAP * 4), e1 = new Float32Array(MAP * MAP * 4), TAU = Math.PI * 2;
  for (const e of fire.emitters) {
    if (e.w > 0) { splat(e0, MAP, rect0, 0, e.x, e.z, 16, e.w / (TAU * 16 * 16)); splat(e1, MAP, rect1, 0, e.x, e.z, 220, e.w / (TAU * 220 * 220)); }
    const lw = Math.max(e.w, 0.25) * e.inten; splat(e0, MAP, rect0, 1, e.x, e.z, 60, lw / (TAU * 60 * 60)); splat(e1, MAP, rect1, 1, e.x, e.z, 260, lw / (TAU * 260 * 260));
    if (Math.hypot(e.x, e.z) < 4000 && e.w > 0) { splat(e0, MAP, rect0, 2, e.x - windTo[0] * 42, e.z - windTo[1] * 42, 28, 0.9); splat(e0, MAP, rect0, 3, e.x - windTo[0] * 30, e.z - windTo[1] * 30, 26, 0.8); }
  }
  for (const d of fire.active) { const bx = d.x - windTo[0] * 250, bz = d.z - windTo[1] * 250; splat(e0, MAP, rect0, 2, bx, bz, 170, 1.15); splat(e1, MAP, rect1, 2, bx, bz, 300, 1); splat(e0, MAP, rect0, 3, bx, bz, 150, 0.7); }
  for (const d of fire.earlier) { splat(e0, MAP, rect0, 2, d.x, d.z, 210, 1.1); splat(e1, MAP, rect1, 2, d.x, d.z, 320, 1); if (d.age < 14) { splat(e0, MAP, rect0, 3, d.x, d.z, 200, 0.5); splat(e1, MAP, rect1, 3, d.x, d.z, 320, 0.4); } }
  for (let i = 2; i < e0.length; i += 4) { e0[i] = Math.min(e0[i], 1.6); e0[i + 1] = Math.min(e0[i + 1], 1); e1[i] = Math.min(e1[i], 1.6); e1[i + 1] = Math.min(e1[i + 1], 1); }
  const E0 = floatMapTexture(e0, MAP), E1 = floatMapTexture(e1, MAP);
  const burnedAt = (x: number, z: number) => { const u = Math.floor((x - rect0[0]) / rect0[2] * MAP), v = Math.floor((z - rect0[1]) / rect0[2] * MAP); return u < 0 || v < 0 || u >= MAP || v >= MAP ? 0 : e0[(v * MAP + u) * 4 + 2]; };
  const heightTex = (rect: [number, number, number]) => { const a = new Uint16Array(HMAP * HMAP);
    for (let j = 0; j < HMAP; j++) for (let i = 0; i < HMAP; i++) a[j * HMAP + i] = THREE.DataUtils.toHalfFloat(ground(rect[0] + (i + 0.5) / HMAP * rect[2], rect[1] + (j + 0.5) / HMAP * rect[2]));
    const t = new THREE.DataTexture(a, HMAP, HMAP, THREE.RedFormat, THREE.HalfFloatType); t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t; };
  const H0 = heightTex(rect0), H1 = heightTex(rect1);

  // ---------- plume ----------
  const groundRef = fire.active.length ? fire.active.reduce((s, d) => s + ground(d.x, d.z), 0) / fire.active.length : ground(0, 0);
  const hmax = Math.max(1200, Math.min(5000, 900 + 55 * Math.sqrt(fire.totalFrp))), leanLen = windSpeed * hmax / 5, layerAlt = groundRef + 0.86 * hmax, yTop = groundRef + 1.45 * hmax;
  const smearRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  const shadow0 = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false }), shadow1 = shadow0.clone();
  const DENSITY = 2.4, LAYER_DENS = 1.5e-3 * Math.max(0.03, Math.min(1, fire.totalFrp / 8000)) ** 0.7;

  // ---------- light for this moment ----------
  const el = sky.sun.elevation, day = smooth(-4, 8, el), golden = smooth(0, 22, el), moonK = sky.moonLit * smooth(0, 12, sky.moon.elevation), night = el < -4;
  const sunDir = new THREE.Vector3(...(night ? (moonK > 0.02 ? direction(sky.moon.azimuth, sky.moon.elevation) : ([0, 1, 0] as Vec3)) : direction(sky.sun.azimuth, Math.max(el, 1))));
  const sunCol = night ? scale3([0.55, 0.68, 1], 0.1 * moonK) : scale3(mix3([1, 0.42, 0.16], [1, 0.95, 0.86], golden), 1.15 * smooth(-1.5, 10, el));
  const nightAmb = scale3([0.022, 0.03, 0.06], 0.35 + 0.65 * moonK), skyAmb = mix3(nightAmb, [0.24, 0.31, 0.43], day), groundAmb = mix3(scale3(nightAmb, 0.4), [0.14, 0.13, 0.11], day);
  const zenith = mix3([0.004, 0.006, 0.016], mix3([0.10, 0.16, 0.36], [0.16, 0.36, 0.78], golden), day), horizon = mix3([0.012, 0.016, 0.03], mix3([0.75, 0.36, 0.17], [0.66, 0.78, 0.95], golden), day);
  const exposure = 3.4 + (1 - 3.4) * smooth(-7, 4, el); // night is shown brighter than a camera would, so the land stays readable by moonlight
  const V3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);
  // Daytime smoke haze (HAZE_FN in shaders.ts): more of it the more fire is burning, none at night. Its colour is thin smoke lit by this sun and sky.
  const hazeK = day * Math.min(1, fire.totalFrp / 6000) ** 0.6, hazeCol: Vec3 = [(sunCol[0] * 0.6 + skyAmb[0]) * 0.78, (sunCol[1] * 0.6 + skyAmb[1]) * 0.72, (sunCol[2] * 0.6 + skyAmb[2]) * 0.64];
  const HZ = { uSmearMap: { value: smearRT.texture }, uHaze: { value: new THREE.Vector4(1.7e-4 * hazeK, 450, 0, 0.15) }, uHazeCol: { value: V3(hazeCol) }, uHazeLit: { value: 1 } };
  const L = { ...HZ, uDay: { value: day },
    uSunDir: { value: sunDir }, uSunCol: { value: V3(sunCol) }, uSkyAmb: { value: V3(skyAmb) }, uGroundAmb: { value: V3(groundAmb) }, uFogCol: { value: V3(mix3(scale3(horizon, 0.9), scale3([0.75, 0.62, 0.5], 0.25 + 0.75 * day), 0.3 * day)) }, uFireCol: { value: new THREE.Vector3(1, 0.45, 0.12) },
    uFogDensity: { value: 3.2e-5 }, uFogBase: { value: groundRef }, uTime: { value: 0 }, uShadowK: { value: DENSITY }, uFireLight: { value: 220 },
    uE0: { value: E0 }, uE1: { value: E1 }, uShadow0: { value: shadow0.texture }, uShadow1: { value: shadow1.texture }, uNoise: { value: noiseTex },
    uE0Rect: { value: new THREE.Vector4(rect0[0], rect0[1], 1 / rect0[2], 1 / rect0[2]) }, uE1Rect: { value: new THREE.Vector4(rect1[0], rect1[1], 1 / rect1[2], 1 / rect1[2]) },
  };
  const windU = { uWindDir: { value: new THREE.Vector2(windTo[0], windTo[1]) }, uWindSpeed: { value: windSpeed } };
  const flameGain = { value: night ? 2.2 : 1.5 };

  // ---------- terrain ----------
  const scene = new THREE.Scene(), N = q.grid, R = 80000, WA = 0.02, warp = (u: number) => Math.sign(u) * (WA * Math.abs(u) + (1 - WA) * Math.abs(u) ** 3), dwarp = (u: number) => WA + (1 - WA) * 3 * u * u;
  const cx17 = lonToTile(frame.lon0, MERC_Z), cy17 = latToTile(frame.lat0, MERC_Z);
  const pos = new Float32Array((N + 1) * (N + 1) * 3), nor = new Float32Array((N + 1) * (N + 1) * 3), merc = new Float32Array((N + 1) * (N + 1) * 2);
  for (let j = 0, o = 0, m = 0; j <= N; j++) for (let i = 0; i <= N; i++, o += 3, m += 2) {
    const u = i / N * 2 - 1, v = j / N * 2 - 1, x = R * warp(u), z = R * warp(v), y = ground(x, z), e = Math.max(15, R * Math.max(dwarp(u), dwarp(v)) * 2 / N);
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
    const nx = ground(x - e, z) - ground(x + e, z), nz = ground(x, z - e) - ground(x, z + e), il = 1 / Math.hypot(nx, 2 * e, nz); nor[o] = nx * il; nor[o + 1] = 2 * e * il; nor[o + 2] = nz * il;
    merc[m] = lonToTile(frame.lon(x), MERC_Z) - cx17; merc[m + 1] = latToTile(frame.lat(z), MERC_Z) - cy17;
  }
  const idx = new Uint32Array(N * N * 6);
  for (let j = 0, o = 0; j < N; j++) for (let i = 0; i < N; i++, o += 6) { const a = j * (N + 1) + i, b = a + N + 1; idx[o] = a; idx[o + 1] = b; idx[o + 2] = a + 1; idx[o + 3] = b; idx[o + 4] = b + 1; idx[o + 5] = a + 1; }
  const tgeo = new THREE.BufferGeometry(); tgeo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); tgeo.setAttribute("normal", new THREE.BufferAttribute(nor, 3)); tgeo.setAttribute("aMerc", new THREE.BufferAttribute(merc, 2)); tgeo.setIndex(new THREE.BufferAttribute(idx, 1));
  // Imagery: coarse to fine. Each coarser level is tinted to match the finer one it surrounds, so seams between satellite mosaics do not show.
  const imgTex = levels.map(m => { const t = new THREE.CanvasTexture(m.canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; });
  const gains: Vec3[] = levels.map(() => [1, 1, 1]);
  for (let k = levels.length - 2; k >= 0; k--) {
    const c = levels[k], f = levels[k + 1], kk = 2 ** (f.z - c.z), fine = meanColor(f.canvas, 0, 0, f.canvas.width, f.canvas.height), coarse = meanColor(c.canvas, (f.x0 / kk - c.x0) * 256, (f.y0 / kk - c.y0) * 256, f.nx / kk * 256, f.ny / kk * 256);
    gains[k] = fine && coarse ? [0, 1, 2].map(i => Math.max(0.55, Math.min(1.8, gains[k + 1][i] * fine[i] / Math.max(coarse[i], 1e-3)))) as Vec3 : gains[k + 1];
  }
  const st = (m: Mosaic) => { const kk = 2 ** (MERC_Z - m.z); return new THREE.Vector4(1 / (kk * m.nx), -1 / (kk * m.ny), (cx17 / kk - m.x0) / m.nx, 1 - (cy17 / kk - m.y0) / m.ny); };
  const fb = meanColor(levels[0].canvas, 0, 0, levels[0].canvas.width, levels[0].canvas.height) ?? [0.08, 0.09, 0.05];
  const terrainMat = new THREE.ShaderMaterial({ vertexShader: G.TERRAIN_VERT, fragmentShader: G.TERRAIN_FRAG, uniforms: { ...L,
    uImgST: { value: [0, 1, 2, 3].map(i => (levels[i] ? st(levels[i]) : new THREE.Vector4())) }, uImg0: { value: imgTex[0] ?? blank }, uImg1: { value: imgTex[1] ?? blank }, uImg2: { value: imgTex[2] ?? blank }, uImg3: { value: imgTex[3] ?? blank },
    uImgCount: { value: levels.length }, uEmberGain: { value: 3 }, uImgGain: { value: [0, 1, 2, 3].map(i => V3(gains[i] ?? [1, 1, 1])) }, uFallback: { value: V3([fb[0] * gains[0][0], fb[1] * gains[0][1], fb[2] * gains[0][2]]) } } });
  const terrain = new THREE.Mesh(tgeo, terrainMat); terrain.frustumCulled = false; scene.add(terrain);

  // ---------- where to stand: near a strong flame front, clear of the smoke, on unburned ground if there is any ----------
  const px = -windTo[1], pz = windTo[0], fronts = fire.emitters.filter(e => e.w > 0 && Math.hypot(e.x, e.z) < 3500), strong = fronts.filter(e => e.kind === 3), pool = strong.length > 20 ? strong : fronts.filter(e => e.h > 3), cand = pool.filter((_, i) => i % Math.max(1, Math.floor(pool.length / 90)) === 0);
  // Can the top of a flame be seen from an eye point, or is a hill in the way?
  const visible = (ex: number, ey: number, ez: number, o: { x: number; z: number; h: number }) => { const ty = ground(o.x, o.z) + o.h; for (let k = 1; k <= 5; k++) { const t = k / 6; if (ground(ex + (o.x - ex) * t, ez + (o.z - ez) * t) > ey + (ty - ey) * t + 1) return false; } return true; };
  // Stand ahead of the front (downwind, where nothing has burned yet) and look back at it; the plume rises overhead.
  let best = { score: -Infinity, target: [0, 0] as [number, number], az: 0 };
  for (const e of cand) for (const th of [0, 30, 55, 80, 100]) for (const sd of [1, -1]) for (const D of [105, 150]) {
    const c = Math.cos(th * D2R), sn = Math.sin(th * D2R) * sd, ox = windTo[0] * c + px * sn, oz = windTo[1] * c + pz * sn, cx = e.x + ox * D, cz = e.z + oz * D;
    let inFire = 0, show = 0, over = 0, seen = 0; const eyeY = ground(cx, cz) + 8;
    for (const o of fronts) { const vx = o.x - cx, vz = o.z - cz, dist = Math.hypot(vx, vz); if (dist < 45) inFire++; else if (dist < 520 && (-vx * ox - vz * oz) / dist > 0.8 && (seen++ % 3 !== 0 || visible(cx, eyeY, cz, o))) show += o.h * (o.kind === 3 ? 2 : 1) * (dist < 300 ? 1.6 : 1); // flames across a wide view, the closer the better
      const al = -(vx * windTo[0] + vz * windTo[1]), ac = Math.abs(vx * px + vz * pz); if (al > 40 && al < 6000 && ac < 60 + 0.25 * al) over += o.w / (1 + al / 1500); } // fire upwind means smoke overhead
    const az = (Math.atan2(ox, -oz) / D2R + 360) % 360, rise = ground(cx, cz) - ground(e.x, e.z);
    // Stand off to one side of the wind so the camera can climb out without passing through the plume; lean toward the south side (a north-up finish needs less turning).
    const score = Math.sqrt(show) * 1.5 - inFire * 4 - burnedAt(cx, cz) * 14 - burnedAt(e.x + ox * D * 0.5, e.z + oz * D * 0.5) * 6 + Math.max(-12, Math.min(12, rise)) * 0.25 - Math.abs(rise) * 0.05 - over * 0.02 - (th < 25 ? 2.5 : 0) + 1.5 * Math.cos((az - 180) * D2R);
    if (score > best.score) best = { score, target: [e.x, e.z], az };
  }
  const groundView: SceneView = { azimuth: best.az, pitch: 2.6, distance: 150, target: best.target };
  const spanKm = Math.max(12, Math.min(70, 2.6 * Math.max(...fire.active.map(d => Math.hypot(d.x, d.z)), 4000) / 1000));
  const overview: SceneView = { azimuth: best.az, pitch: 38, distance: spanKm * 1000, target: [0, 0] };
  const [gdx, , gdz] = direction(best.az, 0), vegC: [number, number] = [best.target[0] + gdx * 80, best.target[1] + gdz * 80], camSpot: [number, number] = [best.target[0] + gdx * 150, best.target[1] + gdz * 150];

  // ---------- plants ----------
  opts.onProgress?.({ stage: "Planting vegetation", done: 0, total: 1 });
  interface Variant { kind: string; radius: number; centerY: number; height: number; width: number; albedo: Vec3 }
  const vegMeta = await (await fetch(`${base}/veg.json`)).json() as { azimuths: number; elevations: number[]; variants: Variant[] };
  const hi = q.hi && renderer.capabilities.maxTextureSize >= 8192, loader = new THREE.TextureLoader();
  const [atlas, atlasN] = await Promise.all([loader.loadAsync(`${base}/veg-color${hi ? "-hi" : ""}.webp`), loader.loadAsync(`${base}/veg-normal${hi ? "-hi" : ""}.webp`)]);
  atlas.colorSpace = THREE.SRGBColorSpace; atlas.anisotropy = 4; atlasN.colorSpace = THREE.NoColorSpace;
  for (const t of [atlas, atlasN]) { t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
  const pix = levels.slice(-2).reverse().map(m => ({ m, d: m.canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, m.canvas.width, m.canvas.height).data, g: gains[levels.indexOf(m)] }));
  const colorAt = (x: number, z: number): Vec3 | null => { const lon = frame.lon(x), lat = frame.lat(z);
    for (const p of pix) { const u = Math.floor((lonToTile(lon, p.m.z) - p.m.x0) * 256), v = Math.floor((latToTile(lat, p.m.z) - p.m.y0) * 256); if (u < 0 || v < 0 || u >= p.m.canvas.width || v >= p.m.canvas.height) continue; const o = (v * p.m.canvas.width + u) * 4; if (p.d[o + 3] < 200) continue; return [p.d[o] / 255, p.d[o + 1] / 255, p.d[o + 2] / 255]; }
    return null; };
  let lumMean = 0, lumN = 0; { const r0 = seeded(5); for (let i = 0; i < 4000; i++) { const c = colorAt((r0() - 0.5) * 1800, (r0() - 0.5) * 1800); if (c) { lumMean += c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11; lumN++; } } } lumMean = lumN ? lumMean / lumN : 0.3;
  const kinds = ["grass", "shrub", "tree"], byKind = kinds.map(k => vegMeta.variants.map((v, i) => (v.kind === k ? i : -1)).filter(i => i >= 0));
  const lum = (a: Vec3) => a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11;
  const varU = Array.from({ length: 12 }, (_, i) => { const v = vegMeta.variants[i]; if (!v) return new THREE.Vector4(); const k = kinds.indexOf(v.kind), target = k === 2 ? 0.05 : 0.065; return new THREE.Vector4(v.radius, v.centerY, k, k === 0 ? 1 : Math.max(0.8, Math.min(6, target / Math.max(lum(v.albedo), 1e-3)))); });
  const cap = q.grass + q.shrubs + q.trees, vp = new Float32Array(cap * 3), va = new Float32Array(cap * 4), vt = new Float32Array(cap * 3), sp = new Float32Array(q.shadows * 3), ss = new Float32Array(q.shadows * 2);
  let vn = 0, sn = 0; const rv = seeded(4242);
  const plant = (kind: number, count: number, radius: number, power: number, sizes: (v: Variant) => [number, number]) => {
    if (!byKind[kind].length) return;
    for (let i = 0; i < count && vn < cap; i++) {
      const a = rv() * TAU, r = radius * rv() ** power, x = vegC[0] + Math.cos(a) * r, z = vegC[1] + Math.sin(a) * r, c = colorAt(x, z); if (!c) continue;
      const l = lum(c), exg = 2 * c[1] - c[0] - c[2], woody = smooth(0.015, 0.09, exg) * smooth(lumMean * 1.05, lumMean * 0.68, l), bare = smooth(0.03, -0.03, exg) * smooth(lumMean, lumMean * 1.5, l);
      if (l < 0.1 && exg < 0.02) continue; // water and deep shadow
      { const vx = x - camSpot[0], vz = z - camSpot[1], al = -(vx * gdx + vz * gdz), lat = Math.abs(vx * gdz - vz * gdx), dc = Math.hypot(vx, vz); // keep the viewpoint and its sightline clear
        if (kind === 2 && (dc < 26 || (al > 0 && al < 90 && lat < 4 + al * 0.2))) continue; if (kind === 1 && (dc < 9 || (al > 0 && al < 40 && lat < 2.5 + al * 0.16))) continue; }
      const p = kind === 2 ? 0.03 + woody * 0.97 : kind === 1 ? (0.22 + woody * 0.6) * (1 - bare) : 0.92 * (1 - bare * 0.8);
      if (rv() > p) continue;
      const burn = burnedAt(x, z) + (rv() - 0.5) * 0.5 > 0.5 ? 1 : 0; if (burn && (kind === 0 || (kind === 1 && rv() < 0.6))) continue;
      const vi = byKind[kind][Math.floor(rv() * byKind[kind].length)], v = vegMeta.variants[vi], [s0, s1] = sizes(v), s = s0 + (s1 - s0) * rv(), lin: Vec3 = [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];
      vp[vn * 3] = x; vp[vn * 3 + 1] = ground(x, z) - v.height * s * 0.03; vp[vn * 3 + 2] = z; va[vn * 4] = s; va[vn * 4 + 1] = rv() * TAU; va[vn * 4 + 2] = vi; va[vn * 4 + 3] = burn;
      const j = 0.82 + rv() * 0.36;
      for (let k = 0; k < 3; k++) vt[vn * 3 + k] = kind === 0 ? Math.max(0.35, Math.min(4, lin[k] / Math.max(v.albedo[k], 0.01) * 1.1)) * j : j * (0.92 + rv() * 0.16) * (k === 0 ? 1 + (rv() - 0.5) * 0.25 : 1);
      if (kind > 0 && sn < q.shadows && r < 1300) { sp[sn * 3] = x; sp[sn * 3 + 1] = vp[vn * 3 + 1]; sp[sn * 3 + 2] = z; ss[sn * 2] = v.width * s; ss[sn * 2 + 1] = v.height * s; sn++; }
      vn++;
    }
  };
  plant(2, q.trees * 3, 5200, 1.7, v => [5.5 / v.height, 10 / v.height]);
  plant(1, Math.round(q.shrubs * 2.2), 1700, 1.6, v => (v.height < 0.8 ? [1.5, 3] : [0.8, 1.5]));
  plant(0, Math.round(q.grass * 1.15), 420, 1.25, () => [1.6, 3.4]);
  const quad = new THREE.PlaneGeometry(2, 2), inst = (n: number) => { const g = new THREE.InstancedBufferGeometry(); g.index = quad.index; g.setAttribute("position", quad.attributes.position); g.setAttribute("uv", quad.attributes.uv); g.instanceCount = n; return g; };
  const vgeo = inst(vn); vgeo.setAttribute("iPos", new THREE.InstancedBufferAttribute(vp.subarray(0, vn * 3), 3)); vgeo.setAttribute("iA", new THREE.InstancedBufferAttribute(va.subarray(0, vn * 4), 4)); vgeo.setAttribute("iTint", new THREE.InstancedBufferAttribute(vt.subarray(0, vn * 3), 3));
  const vegMat = new THREE.ShaderMaterial({ vertexShader: G.VEG_VERT, fragmentShader: G.VEG_FRAG, side: THREE.DoubleSide, uniforms: { ...L, ...windU, uVar: { value: varU }, uKindDist: { value: new THREE.Vector3(450, 2600, 12000) }, uAtlas: { value: atlas }, uAtlasN: { value: atlasN }, uGrid: { value: new THREE.Vector2(vegMeta.azimuths * vegMeta.elevations.length, vegMeta.variants.length) } } });
  const veg = new THREE.Mesh(vgeo, vegMat); veg.frustumCulled = false; scene.add(veg);
  const shadowStrength = { value: 0.5 * smooth(4, 22, el) };
  if (sn && shadowStrength.value > 0.02) {
    const sgeo = inst(sn); sgeo.setAttribute("iPos", new THREE.InstancedBufferAttribute(sp.subarray(0, sn * 3), 3)); sgeo.setAttribute("iS", new THREE.InstancedBufferAttribute(ss.subarray(0, sn * 2), 2));
    const sm = new THREE.Mesh(sgeo, new THREE.ShaderMaterial({ vertexShader: G.SHADOW_VERT, fragmentShader: G.SHADOW_FRAG, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, uniforms: { uSunDir: L.uSunDir, uMaxDist: { value: 1500 }, uStrength: shadowStrength } }));
    sm.frustumCulled = false; sm.renderOrder = 1; scene.add(sm);
  }

  // ---------- flames and embers ----------
  const fn = fire.emitters.length, fp = new Float32Array(fn * 3), fq = new Float32Array(fn * 4);
  fire.emitters.forEach((e, i) => { fp[i * 3] = e.x; fp[i * 3 + 1] = ground(e.x, e.z) - 0.2; fp[i * 3 + 2] = e.z; fq[i * 4] = e.wd; fq[i * 4 + 1] = e.h; fq[i * 4 + 2] = e.seed; fq[i * 4 + 3] = e.inten; });
  const fgeo = inst(fn); fgeo.setAttribute("iPos", new THREE.InstancedBufferAttribute(fp, 3)); fgeo.setAttribute("iP", new THREE.InstancedBufferAttribute(fq, 4));
  const flameMat = new THREE.ShaderMaterial({ vertexShader: G.FLAME_VERT, fragmentShader: G.FLAME_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { ...windU, ...HZ, uFogBase: L.uFogBase, uE1Rect: L.uE1Rect, uLean: { value: Math.min(0.9, windSpeed * 0.07) }, uFlameRef: { value: 900 }, uNoise: L.uNoise, uTime: L.uTime, uFlameGain: flameGain } });
  const flames = new THREE.Mesh(fgeo, flameMat); flames.frustumCulled = false; flames.renderOrder = 3; if (fn) scene.add(flames);
  const flameDepth = new THREE.Mesh(fgeo, new THREE.ShaderMaterial({ vertexShader: G.FLAME_VERT, fragmentShader: G.FLAME_FRAG, defines: { DEPTH_ONLY: 1 }, colorWrite: false, side: THREE.DoubleSide, uniforms: flameMat.uniforms })); flameDepth.frustumCulled = false; flameDepth.renderOrder = 2; if (fn) scene.add(flameDepth);
  const nearE = fire.emitters.filter(e => Math.hypot(e.x, e.z) < 2500 && e.w > 0), en = nearE.length ? q.embers : 0, ep = new Float32Array(en * 3), es = new Float32Array(en * 4), re = seeded(99);
  for (let i = 0; i < en; i++) { const e = nearE[Math.floor(re() * nearE.length)]; ep[i * 3] = e.x + (re() - 0.5) * 6; ep[i * 3 + 1] = ground(e.x, e.z) + e.h * (0.3 + 0.7 * re()); ep[i * 3 + 2] = e.z + (re() - 0.5) * 6; for (let k = 0; k < 4; k++) es[i * 4 + k] = re(); }
  const egeo = new THREE.BufferGeometry(); egeo.setAttribute("position", new THREE.BufferAttribute(ep, 3)); egeo.setAttribute("iSeed", new THREE.BufferAttribute(es, 4));
  const emberMat = new THREE.ShaderMaterial({ vertexShader: G.EMBER_VERT, fragmentShader: G.EMBER_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...windU, uTime: L.uTime, uPx: { value: 1400 }, uFlameGain: flameGain } });
  const embers = new THREE.Points(egeo, emberMat); embers.frustumCulled = false; embers.renderOrder = 4; if (en) scene.add(embers);

  // ---------- sky ----------
  const skyMat = new THREE.ShaderMaterial({ vertexShader: G.SKY_VERT, fragmentShader: G.SKY_FRAG, side: THREE.BackSide, depthWrite: false, uniforms: { ...HZ, uFogBase: L.uFogBase, uE1Rect: L.uE1Rect,
    uSun: { value: new THREE.Vector3(...direction(sky.sun.azimuth, el)) }, uMoon: { value: new THREE.Vector3(...direction(sky.moon.azimuth, sky.moon.elevation)) }, uZenith: { value: V3(zenith) }, uHorizon: { value: V3(horizon) },
    uSunDisc: { value: V3(scale3(mix3([1, 0.4, 0.12], [1, 0.95, 0.85], golden), smooth(-1.5, 4, el))) }, uMoonCol: { value: V3(scale3([0.8, 0.86, 1], 0.5 * sky.moonLit * smooth(-2, 4, sky.moon.elevation))) }, uStars: { value: (1 - day) * 0.6 } } });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMat); dome.frustumCulled = false; dome.renderOrder = -10; scene.add(dome);

  // ---------- post-processing ----------
  const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 1, 500000), fsScene = new THREE.Scene(), fsCam = new THREE.Camera();
  const fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); fsMesh.frustumCulled = false; fsScene.add(fsMesh);
  const fsMat = (frag: string, uniforms: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}) => new THREE.ShaderMaterial({ vertexShader: G.FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra });
  const pass = (m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => { fsMesh.material = m; renderer.setRenderTarget(target); renderer.render(fsScene, fsCam); };
  pass(fsMat(G.SMEAR_FRAG, { uE1: { value: E1 }, uWindUv: { value: new THREE.Vector2(windTo[0], windTo[1]) }, uSizeM: { value: FAR_SIZE }, uTexelM: { value: FAR_SIZE / MAP }, uCap: { value: leanLen * 1.81 }, uReach: { value: 150000 } }), smearRT);
  // Scale the drifted-smoke map by its thickest point (read back once).
  let smearInv = 1; try { const buf = new Uint16Array(512 * 512 * 4); renderer.readRenderTargetPixels(smearRT, 0, 0, 512, 512, buf); let mx = 0, mxAll = 0; for (let i = 0; i < buf.length; i += 4) { mx = Math.max(mx, THREE.DataUtils.fromHalfFloat(buf[i])); mxAll = Math.max(mxAll, THREE.DataUtils.fromHalfFloat(buf[i + 1])); } if (mx > 0) smearInv = 1 / mx; if (mxAll > 0) HZ.uHaze.value.z = 3 / mxAll; } catch { smearInv = 1 / (leanLen * 0.002); }
  const plumeU = { uE0: L.uE0, uE1: L.uE1, uSmear: { value: smearRT.texture }, uH0: { value: H0 }, uH1: { value: H1 }, uVol: { value: vol }, uE0Rect: L.uE0Rect, uE1Rect: L.uE1Rect, uSunDir: L.uSunDir, uWind: windU.uWindDir, uWindSpeed: windU.uWindSpeed, uTime: L.uTime,
    uHmax: { value: hmax }, uLeanLen: { value: leanLen }, uLayerAlt: { value: layerAlt }, uGroundRef: { value: groundRef }, uYTop: { value: yTop }, uDensity: { value: DENSITY }, uLayerDens: { value: LAYER_DENS }, uSmearInv: { value: smearInv }, uCover: { value: 0.11 }, uSmoulderK: { value: 3e-5 }, uE0Texel: { value: NEAR_SIZE / MAP }, uE1Texel: { value: FAR_SIZE / MAP } };
  const bakeMat = fsMat(G.SHADOW_BAKE_FRAG, { ...plumeU, uRect: { value: new THREE.Vector3() } });
  const shadowCpu: (Float32Array | null)[] = [null, null];
  const bakeShadows = () => { ([[shadow0, rect0], [shadow1, rect1]] as const).forEach(([rt, r], k) => { bakeMat.uniforms.uRect.value.set(r[0], r[1], r[2]); pass(bakeMat, rt);
    if (hazeK <= 0) return; // only the daytime haze needs the copy
    try { const buf = new Uint16Array(512 * 512 * 4), a = new Float32Array(512 * 512); renderer.readRenderTargetPixels(rt, 0, 0, 512, 512, buf); for (let i = 0; i < a.length; i++) a[i] = THREE.DataUtils.fromHalfFloat(buf[i * 4]); shadowCpu[k] = a; } catch { shadowCpu[k] = null; } }); };
  /** Share of direct sun reaching the ground at a point: 1 in the clear, toward 0 under thick smoke. */
  const sunAt = (x: number, z: number) => {
    const at = (k: number, r: readonly [number, number, number]) => { const a = shadowCpu[k]; if (!a) return null; const u = (x - r[0]) / r[2] * 512 - 0.5, v = (z - r[1]) / r[2] * 512 - 0.5; if (u < 0 || v < 0 || u > 511 || v > 511) return null;
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, i1 = Math.min(511, i + 1), j1 = Math.min(511, j + 1);
      return (a[j * 512 + i] * (1 - fu) + a[j * 512 + i1] * fu) * (1 - fv) + (a[j1 * 512 + i] * (1 - fu) + a[j1 * 512 + i1] * fu) * fv; };
    const od = at(0, rect0) ?? at(1, rect1); return od === null ? 1 : Math.exp(-L.uShadowK.value * od); };
  bakeShadows();
  const smokeMat = fsMat(G.SMOKE_FRAG, { ...plumeU, ...HZ, uDay: L.uDay, uFogBase: L.uFogBase, tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uSunCol: L.uSunCol, uSkyAmb: L.uSkyAmb, uGroundAmb: L.uGroundAmb, uFireCol: L.uFireCol,
    uFireGlow: { value: night ? 14 : 60 }, uJitter: { value: 0 }, uStepMin: { value: quality === "film" ? 4 : 7 }, uStepK: { value: quality === "film" ? 0.075 : quality === "low" ? 0.16 : 0.115 }, uMaxT: { value: 170000 }, uSteps: { value: q.steps }, uLightSteps: { value: q.light } });
  const compMat = fsMat(G.COMPOSITE_FRAG, { tScene: { value: null }, tSmoke: { value: null }, uSmokeTexel: { value: new THREE.Vector2() } });
  const downMat = fsMat(G.BLOOM_DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 } });
  const upMat = fsMat(G.BLOOM_UP_FRAG, { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() }, uSpread: { value: 0.85 } });
  const finalMat = fsMat(G.FINAL_FRAG, { tComp: { value: null }, tBloom: { value: null }, uExposure: { value: exposure }, uBloom: { value: 0.32 }, uGrain: { value: 0.018 }, uTime: L.uTime });
  const addMat = fsMat(G.COPY_FRAG, { tSrc: { value: null }, uGain: { value: 1 } }, { blending: THREE.AdditiveBlending, transparent: true });
  const copyMat = fsMat(G.COPY_FRAG, { tSrc: { value: null }, uGain: { value: 1 } });
  const hdr = (w: number, h: number, depth = false) => { const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: depth }); if (depth) { t.depthTexture = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h)); t.depthTexture.type = THREE.UnsignedIntType; } return t; };
  let rtScene = hdr(1, 1, true), rtSmoke = hdr(1, 1), rtComp = hdr(1, 1), rtLdr = hdr(1, 1), rtAccum = hdr(1, 1), down: THREE.WebGLRenderTarget[] = [], up: THREE.WebGLRenderTarget[] = [], W = 1, H = 1, scale = 1;
  const BLOOM = 5;
  const resize = () => {
    const css = opts.fixedSize ?? [canvas.clientWidth || 1280, canvas.clientHeight || 720], dpr = opts.fixedSize ? 1 : Math.min(window.devicePixelRatio || 1, quality === "high" ? 1.5 : 1);
    W = Math.max(2, Math.round(css[0] * dpr * scale)); H = Math.max(2, Math.round(css[1] * dpr * scale));
    renderer.setSize(W, H, false);
    for (const t of [rtScene, rtSmoke, rtComp, rtLdr, rtAccum, ...down, ...up]) t.dispose();
    rtScene = hdr(W, H, true); rtSmoke = hdr(Math.round(W * q.smoke), Math.round(H * q.smoke)); rtComp = hdr(W, H); rtLdr = hdr(W, H); rtAccum = hdr(W, H);
    down = Array.from({ length: BLOOM }, (_, i) => hdr(W >> (i + 1), H >> (i + 1))); up = Array.from({ length: BLOOM - 1 }, (_, i) => hdr(W >> (i + 1), H >> (i + 1)));
    camera.aspect = W / H; camera.updateProjectionMatrix(); emberMat.uniforms.uPx.value = H / (2 * Math.tan(FOV * D2R / 2));
  };
  resize();

  // ---------- camera ----------
  let view: SceneView = { ...groundView }, frameNo = 0;
  const applyView = (v: SceneView) => {
    const [tx, tz] = v.target ?? [0, 0], ty = ground(tx, tz) + 3 + Math.min(v.distance * 0.04, 40), p = Math.max(0.5, Math.min(89.9, v.pitch)), [dx, dy, dz] = direction(v.azimuth, p);
    camera.position.set(tx + dx * v.distance, ty + dy * v.distance, tz + dz * v.distance);
    const floor = ground(camera.position.x, camera.position.z) + 2.2; if (camera.position.y < floor) camera.position.y = floor;
    const a = v.azimuth * D2R, sp2 = Math.sin(p * D2R); camera.up.set(-sp2 * Math.sin(a), Math.cos(p * D2R), sp2 * Math.cos(a)); camera.lookAt(tx, ty, tz);
    const agl = camera.position.y - (floor - 2.2); camera.near = Math.max(0.4, Math.min(400, agl * 0.03)); camera.far = Math.max(140000, v.distance * 6 + 60000);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  };
  const draw = (t: number, target: THREE.WebGLRenderTarget | null) => {
    L.uTime.value = t; frameNo++;
    if (hazeK > 0) { const sun = sunAt(camera.position.x, camera.position.z), low = 1 - smooth(250, 2000, camera.position.y - ground(camera.position.x, camera.position.z));
      HZ.uHazeLit.value = 0.5 + 0.5 * sun; finalMat.uniforms.uExposure.value = exposure * (1 + 0.6 * day * (1 - sun) * low); }
    renderer.setRenderTarget(rtScene); renderer.render(scene, camera);
    const su = smokeMat.uniforms; su.tDepth.value = rtScene.depthTexture; su.uInvProj.value.copy(camera.projectionMatrixInverse); su.uInvView.value.copy(camera.matrixWorld); su.uCamPos.value.copy(camera.position); su.uJitter.value = frameNo % 64;
    pass(smokeMat, rtSmoke);
    compMat.uniforms.tScene.value = rtScene.texture; compMat.uniforms.tSmoke.value = rtSmoke.texture; { const k = q.smoke >= 1 ? 0.6 : 1; compMat.uniforms.uSmokeTexel.value.set(k / rtSmoke.width, k / rtSmoke.height); } pass(compMat, rtComp);
    for (let i = 0; i < BLOOM; i++) { const src = i ? down[i - 1] : rtComp; downMat.uniforms.tSrc.value = src.texture; downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height); downMat.uniforms.uThreshold.value = i ? 0 : 1.5; pass(downMat, down[i]); }
    for (let i = BLOOM - 2; i >= 0; i--) { const src = i === BLOOM - 2 ? down[BLOOM - 1] : up[i + 1]; upMat.uniforms.tSrc.value = src.texture; upMat.uniforms.tAdd.value = down[i].texture; upMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height); pass(upMat, up[i]); }
    finalMat.uniforms.tComp.value = rtComp.texture; finalMat.uniforms.tBloom.value = up[0].texture; pass(finalMat, target);
  };
  let raf = 0, last = 0, clock = 0, slow = 0, fast = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop); const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now; clock += dt;
    applyView(view); draw(clock, null);
    if (quality !== "film" && !opts.fixedSize) { // keep it interactive on slower graphics by lowering the internal resolution
      if (dt > 0.045) slow++; else if (dt < 0.02) fast++;
      if (slow > 40 && scale > 0.45) { scale *= 0.85; slow = fast = 0; resize(); } else if (fast > 600 && scale < 1) { scale = Math.min(1, scale / 0.9); slow = fast = 0; resize(); }
    }
  };
  const halton = (i: number, b: number) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };

  return {
    info: { detections: fire.active.length, earlier: fire.earlier.length, flames: fn, plants: vn, sunElevation: el, moonLit: sky.moonLit, night, plumeTopM: hmax, windFrom: data.wind?.dirFrom ?? null, windSpeed: data.wind?.speed ?? null, imageryLevels: levels.length, groundM: groundRef },
    ground: groundView, overview,
    getView: () => ({ ...view }), setView: v => { view = { ...v }; },
    flight: (u, end, style = {}) => {
      // groundShare: part of the move spent near the ground; pan: degrees the camera sweeps sideways while there.
      const g = groundView, share = style.groundShare ?? 0.26, d0 = style.startDistance ?? g.distance, p0 = style.startPitch ?? g.pitch, e = end ?? { target: [0, 0] as [number, number], distance: overview.distance * 1.4 };
      const creep = smooth(0, share + 0.04, u), x = Math.max(0, Math.min(1, (u - share) / (1 - share))), go = 0.5 * (1 + Math.tanh(9.5 * (x - 0.5)) / Math.tanh(4.75)); // slow at the ground and at the top, quick through the smoke in between
      const turn = ((180 - g.azimuth + 540) % 360) - 180, gt = g.target ?? [0, 0], k = smooth(0.12, 1, go), pan = (style.pan ?? 6) * (creep - 0.5) * (1 - go);
      return { azimuth: (g.azimuth + turn * smooth(0, 0.8, go) + pan + 360) % 360, pitch: p0 + creep * 0.9 + (89.9 - p0 - 0.9) * go ** 0.8, distance: Math.exp(Math.log(d0 * (1 - creep * 0.19)) * (1 - go) + Math.log(e.distance) * go), target: [gt[0] + (e.target[0] - gt[0]) * k, gt[1] + (e.target[1] - gt[1]) * k] };
    },
    project: (lon, lat) => [frame.x(lon), frame.z(lat)],
    render: t => { applyView(view); draw(t, null); },
    renderAccumulated: (views, times) => {
      const n = views.length; renderer.setRenderTarget(rtAccum); renderer.clear();
      for (let k = 0; k < n; k++) {
        applyView(views[k]); camera.setViewOffset(W, H, halton(k + 1, 2) - 0.5, halton(k + 1, 3) - 0.5, W, H); camera.updateProjectionMatrix();
        draw(times[k], rtLdr);
        addMat.uniforms.tSrc.value = rtLdr.texture; addMat.uniforms.uGain.value = 1 / n; renderer.autoClear = false; pass(addMat, rtAccum); renderer.autoClear = true;
      }
      camera.clearViewOffset(); copyMat.uniforms.tSrc.value = rtAccum.texture; pass(copyMat, null); view = { ...views[n - 1] };
    },
    tune: (name, value) => { for (const m of [terrainMat, vegMat, flameMat, emberMat, skyMat, smokeMat, bakeMat, compMat, finalMat]) if (m.uniforms[name]) m.uniforms[name].value = value; if (name === "uDensity") L.uShadowK.value = value; if (["uDensity", "uLayerDens", "uCover", "uHmax"].includes(name)) bakeShadows(); },
    start: () => { if (!raf) { last = 0; raf = requestAnimationFrame(loop); } },
    stop: () => { cancelAnimationFrame(raf); raf = 0; },
    resize,
    attachControls: onChange => {
      let drag: { x: number; y: number; pan: boolean } | null = null; const pts = new Map<number, [number, number]>(); let pinch = 0;
      const clampView = () => { view.pitch = Math.max(1, Math.min(89.5, view.pitch)); view.distance = Math.max(25, Math.min(160000, view.distance)); const t = view.target ?? [0, 0]; view.target = [Math.max(-30000, Math.min(30000, t[0])), Math.max(-30000, Math.min(30000, t[1]))]; onChange?.(); };
      const down2 = (e: PointerEvent) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } };
      const move = (e: PointerEvent) => {
        if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
        if (pts.size === 2) { const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch > 0) view.distance *= pinch / Math.max(d, 1); pinch = d; clampView(); return; }
        if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        if (drag.pan) { const a = view.azimuth * D2R, k = view.distance / Math.max(canvas.clientHeight, 300) * 1.4, t = view.target ?? [0, 0]; view.target = [t[0] + (Math.cos(a) * dx - Math.sin(a) * dy) * k, t[1] + (Math.sin(a) * dx + Math.cos(a) * dy) * k]; }
        else { view.azimuth = (view.azimuth - dx * 0.25 + 360) % 360; view.pitch += dy * 0.2; }
        clampView();
      };
      const upF = (e: PointerEvent) => { pts.delete(e.pointerId); if (!pts.size) drag = null; pinch = 0; };
      const wheel = (e: WheelEvent) => { e.preventDefault(); view.distance *= Math.exp(Math.max(-1, Math.min(1, e.deltaY / 300)) * 0.5); clampView(); };
      const ctx = (e: Event) => e.preventDefault();
      canvas.addEventListener("pointerdown", down2); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", upF); canvas.addEventListener("pointercancel", upF); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("contextmenu", ctx);
      return () => { canvas.removeEventListener("pointerdown", down2); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", upF); canvas.removeEventListener("pointercancel", upF); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("contextmenu", ctx); };
    },
    dispose: () => {
      cancelAnimationFrame(raf); raf = 0;
      for (const t of [rtScene, rtSmoke, rtComp, rtLdr, rtAccum, smearRT, shadow0, shadow1, ...down, ...up]) t.dispose();
      for (const t of [E0, E1, H0, H1, noiseTex, vol, blank, atlas, atlasN, ...imgTex]) t.dispose();
      scene.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
      renderer.dispose();
    },
  };
}
