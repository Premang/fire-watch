// Tile loading for the 3D fire view: elevation (AWS Terrain Tiles, terrarium encoding) and aerial imagery (Esri World Imagery).
import { latToTile, lonToTile } from "./geo";

export const DEM_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const IMAGERY_URL = (z: number, x: number, y: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const IMAGERY_CREDIT = "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
export const DEM_CREDIT = "Elevation: Mapzen Terrain Tiles on AWS (SRTM and other open sources)";

function loadImage(url: string, tries = 3): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const attempt = (left: number) => {
      const im = new Image(); im.crossOrigin = "anonymous"; im.decoding = "async";
      im.onload = () => resolve(im);
      im.onerror = () => (left > 1 ? setTimeout(() => attempt(left - 1), 400) : resolve(null));
      im.src = url;
    };
    attempt(tries);
  });
}
export interface Mosaic { z: number; x0: number; y0: number; nx: number; ny: number; canvas: HTMLCanvasElement; missing: number }

/** Download an nx-by-ny block of tiles around a point into one canvas. Tiles that fail stay transparent. */
export async function loadMosaic(z: number, lat: number, lon: number, nx: number, ny: number, url: (z: number, x: number, y: number) => string, tick: () => void, checkPlaceholder = false): Promise<Mosaic> {
  const max = 2 ** z, x0 = Math.floor(lonToTile(lon, z) - nx / 2 + 0.5), y0 = Math.max(0, Math.min(max - ny, Math.floor(latToTile(lat, z) - ny / 2 + 0.5)));
  const canvas = document.createElement("canvas"); canvas.width = nx * 256; canvas.height = ny * 256;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const jobs: [number, number][] = []; for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) jobs.push([i, j]);
  let missing = 0, next = 0;
  const probe = document.createElement("canvas"); probe.width = probe.height = 8; const pctx = probe.getContext("2d", { willReadFrequently: true })!;
  const worker = async () => {
    for (;;) {
      const k = next++; if (k >= jobs.length) return; const [i, j] = jobs[k];
      const im = await loadImage(url(z, ((x0 + i) % max + max) % max, y0 + j)); tick();
      if (!im) { missing++; continue; }
      if (checkPlaceholder) { // Esri answers 200 with a flat grey "Map data not yet available" tile where it has no imagery at this zoom
        pctx.drawImage(im, 0, 0, 8, 8); const d = pctx.getImageData(0, 0, 8, 8).data; let flat = 0;
        for (let q = 0; q < d.length; q += 4) if (Math.abs(d[q] - d[q + 1]) < 3 && Math.abs(d[q] - d[q + 2]) < 3 && d[q] > 190 && d[q] < 215) flat++;
        if (flat >= 56) { missing++; continue; }
      }
      ctx.drawImage(im, i * 256, j * 256);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  return { z, x0, y0, nx, ny, canvas, missing };
}

/** Elevation grid decoded from a terrarium mosaic, sampled by longitude and latitude. */
export class HeightField {
  readonly w: number; readonly h: number; readonly data: Float32Array; readonly m: Mosaic; min = Infinity; max = -Infinity;
  constructor(m: Mosaic) {
    this.m = m; this.w = m.canvas.width; this.h = m.canvas.height;
    const px = m.canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, this.w, this.h).data; this.data = new Float32Array(this.w * this.h);
    for (let i = 0, o = 0; i < this.data.length; i++, o += 4) {
      const v = px[o + 3] === 0 ? NaN : px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768; this.data[i] = v;
      if (v === v) { if (v < this.min) this.min = v; if (v > this.max) this.max = v; }
    }
    if (!Number.isFinite(this.min)) { this.min = 0; this.max = 0; }
    for (let i = 0; i < this.data.length; i++) if (this.data[i] !== this.data[i]) this.data[i] = this.min; // failed tiles become flat ground
  }
  /** Position inside the grid in pixels, or null when outside. */
  locate(lon: number, lat: number): [number, number] | null {
    const u = (lonToTile(lon, this.m.z) - this.m.x0) * 256 - 0.5, v = (latToTile(lat, this.m.z) - this.m.y0) * 256 - 0.5;
    return u < 0 || v < 0 || u > this.w - 1 || v > this.h - 1 ? null : [u, v];
  }
  at(u: number, v: number) {
    const i = Math.min(this.w - 2, Math.floor(u)), j = Math.min(this.h - 2, Math.floor(v)), fu = u - i, fv = v - j, d = this.data, o = j * this.w + i;
    return (d[o] * (1 - fu) + d[o + 1] * fu) * (1 - fv) + (d[o + this.w] * (1 - fu) + d[o + this.w + 1] * fu) * fv;
  }
  /** How far a point is inside the grid, 0 at the edge to 1 well inside (for blending two grids). */
  weight(u: number, v: number) { const e = Math.min(u, v, this.w - 1 - u, this.h - 1 - v) / (0.08 * Math.min(this.w, this.h)); return Math.max(0, Math.min(1, e)); }
}
/** Mean colour of a rectangle of a canvas, linearised (approximate gamma 2.2). */
export function meanColor(c: HTMLCanvasElement, x: number, y: number, w: number, h: number): [number, number, number] | null {
  const s = document.createElement("canvas"); s.width = s.height = 32; const g = s.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(c, x, y, w, h, 0, 0, 32, 32); const d = g.getImageData(0, 0, 32, 32).data; let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { r += (d[i] / 255) ** 2.2; gg += (d[i + 1] / 255) ** 2.2; b += (d[i + 2] / 255) ** 2.2; n++; }
  return n < 200 ? null : [r / n, gg / n, b / n];
}
