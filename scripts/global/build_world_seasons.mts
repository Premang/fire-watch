// Builds public/data/harmonized/world-seasons.bin: the mean harmonized activity per calendar month
// (baseline years from meta.json) on an 80 km equal-area grid, for the landing-page world animation.
// Layout: "EAW1", u16 nx, u16 ny, u16 cellKm, u16 baselineFirst, u16 baselineLast, u32 n, u32 index[n], u8 value[n*12].
// value = round(255 * log1p(mean) / log1p(max)); index = iy * nx + ix, iy counted from the south.
// Usage: node --experimental-strip-types scripts/global/build_world_seasons.mts
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const R_KM = 6371;
// Minimal EAT1 reader (same format as lib/harmonized/data.ts parseTile).
function parseTile(b: Uint8Array) {
  let pos = 4;
  const varint = () => { let r = 0, s = 0, x: number; do { x = b[pos++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; };
  const zigzag = () => { const v = varint(); return v % 2 ? -(v + 1) / 2 : v / 2; };
  varint(); const cellKm = varint(), tx = zigzag(), ty = zigzag(), tileCells = varint(), monthBase = varint(), fields = varint();
  const n = varint(), cells: { index: number; months: number[]; values: number[] }[] = [];
  let index = 0;
  for (let c = 0; c < n; c++) {
    index += varint();
    const k = varint(), months: number[] = [], values: number[] = [];
    let m = monthBase;
    for (let i = 0; i < k; i++) { m += varint(); months.push(m); for (let f = 0; f < fields; f++) values.push(varint()); }
    cells.push({ index, months, values });
  }
  return { cellKm, tx, ty, tileCells, fields, cells };
}

const root = "public/data/harmonized";
const meta = JSON.parse(readFileSync(`${root}/meta.json`, "utf8"));
const OUT_KM = 80;
const COS30 = Math.cos(Math.PI / 6);
const halfW = Math.PI * R_KM * COS30, halfH = R_KM / COS30;
const nx = Math.ceil(2 * halfW / OUT_KM), ny = Math.ceil(2 * halfH / OUT_KM);
const [b0, b1] = meta.baseline as [number, number];
const years = b1 - b0 + 1;
const sums = new Map<number, Float64Array>();
const dir = `${root}/tiles/L1`;
for (const name of readdirSync(dir)) {
  const t = parseTile(new Uint8Array(gunzipSync(readFileSync(`${dir}/${name}`))));
  for (const c of t.cells) {
    const cx = t.tx * t.tileCells + (c.index % t.tileCells), cy = t.ty * t.tileCells + Math.floor(c.index / t.tileCells);
    const ix = Math.floor((cx * t.cellKm + t.cellKm / 2 + halfW) / OUT_KM), iy = Math.floor((cy * t.cellKm + t.cellKm / 2 + halfH) / OUT_KM);
    if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) continue;
    const key = iy * nx + ix;
    let a = sums.get(key); if (!a) sums.set(key, a = new Float64Array(12));
    for (let k = 0; k < c.months.length; k++) {
      const m = c.months[k], y = 2000 + Math.floor(m / 12), mo = m % 12;
      if (y < b0 || y > b1) continue;
      a[mo] += c.values[k * t.fields] / 10 / years; // h10 = harmonized cell-days x 10
    }
  }
}
let max = 0; for (const a of sums.values()) for (const v of a) max = Math.max(max, v);
const keys = [...sums.keys()].filter(k => Math.max(...sums.get(k)!) >= 0.05).sort((a, b) => a - b);
const buf = Buffer.alloc(4 + 10 + 4 + keys.length * 4 + keys.length * 12);
buf.write("EAW1", 0, "ascii");
[nx, ny, OUT_KM, b0, b1].forEach((v, i) => buf.writeUInt16LE(v, 4 + i * 2));
buf.writeUInt32LE(keys.length, 14);
keys.forEach((k, i) => buf.writeUInt32LE(k, 18 + i * 4));
const off = 18 + keys.length * 4;
keys.forEach((k, i) => sums.get(k)!.forEach((v, m) => buf.writeUInt8(Math.min(255, Math.round(255 * Math.log1p(v) / Math.log1p(max))), off + i * 12 + m)));
writeFileSync(`${root}/world-seasons.bin`, buf);
console.log(`world-seasons.bin: ${nx}x${ny} grid, ${keys.length} cells, max ${max.toFixed(1)} cell-days/month, ${(buf.length / 1024).toFixed(0)} KB`);
