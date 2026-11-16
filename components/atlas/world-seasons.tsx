"use client";

// Landing-page world view: mean harmonized burning per calendar month on an 80 km equal-area grid,
// animated through the year. Data: public/data/harmonized/world-seasons.bin (scripts/global/build_world_seasons.mts).
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { MONTHS, MONTHS_LONG, type Lang } from "@/lib/harmonized/i18n";

const R_KM = 6371, COS30 = Math.cos(Math.PI / 6);
const CROP_SOUTH = 14; // rows below about 58 deg S hold no land with burning
const MS_PER_MONTH = 1100;

interface World { nx: number; ny: number; cellKm: number; baseline: [number, number]; index: Uint32Array; values: Uint8Array }

function parse(buf: ArrayBuffer): World {
  const d = new DataView(buf);
  if (String.fromCharCode(d.getUint8(0), d.getUint8(1), d.getUint8(2), d.getUint8(3)) !== "EAW1") throw new Error("Not a world-seasons file");
  const nx = d.getUint16(4, true), ny = d.getUint16(6, true), cellKm = d.getUint16(8, true), n = d.getUint32(14, true);
  const index = new Uint32Array(n);
  for (let i = 0; i < n; i++) index[i] = d.getUint32(18 + i * 4, true);
  return { nx, ny, cellKm, baseline: [d.getUint16(10, true), d.getUint16(12, true)], index, values: new Uint8Array(buf, 18 + n * 4, n * 12) };
}

// Ember ramp: quiet land -> deep red -> orange -> yellow -> near white.
const STOPS: [number, number, number, number][] = [[0, 38, 40, 45], [0.12, 74, 30, 20], [0.35, 168, 46, 20], [0.6, 244, 115, 58], [0.82, 255, 205, 96], [1, 255, 246, 216]];
const LUT = (() => {
  const out = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = Math.pow(v / 255, 0.85);
    let k = 0; while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const a = STOPS[k], b = STOPS[k + 1], f = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
    for (let c = 0; c < 3; c++) out[v * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f;
  }
  return out;
})();

const T = {
  en: { kicker: "THE WORLD'S FIRE SEASONS", sub: (a: number, b: number) => `Average burning in each month, ${a}–${b} · harmonized MODIS + VIIRS`, hint: "Click anywhere on the map to open that area's calendar", play: "Play the year", pause: "Pause", months: "Month", alt: "World map of average satellite-detected burning for each month of the year", low: "less", high: "more burning" },
  es: { kicker: "LAS TEMPORADAS DE FUEGO DEL MUNDO", sub: (a: number, b: number) => `Quema promedio de cada mes, ${a}–${b} · MODIS + VIIRS armonizados`, hint: "Haga clic en el mapa para abrir el calendario de esa zona", play: "Reproducir el año", pause: "Pausar", months: "Mes", alt: "Mapa mundial de la quema promedio detectada por satélite en cada mes del año", low: "menos", high: "más quema" },
} as const;

export default function WorldSeasons({ lang = "en", onPick }: { lang?: Lang; onPick?: (lat: number, lon: number) => void }) {
  const t = T[lang];
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<World | null>(null);
  const pos = useRef(7); // fractional month; starts in August
  const [baseline, setBaseline] = useState<[number, number] | null>(null);
  const ready = baseline !== null;
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [month, setMonth] = useState(7);
  const [seek, setSeek] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/data/harmonized/world-seasons.bin").then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
      .then(b => { if (cancelled) return; world.current = parse(b); setBaseline(world.current.baseline); setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const w = world.current, cv = canvas.current;
    if (!ready || !w || !cv) return;
    const rows = w.ny - CROP_SOUTH;
    const small = document.createElement("canvas"); small.width = w.nx; small.height = rows;
    const sg = small.getContext("2d")!, img = sg.createImageData(w.nx, rows);
    const g = cv.getContext("2d")!;
    let raf = 0, last = 0, shown = -1;
    const draw = (p: number) => {
      const m0 = Math.floor(p) % 12, m1 = (m0 + 1) % 12, f = p - Math.floor(p), px = img.data;
      px.fill(0);
      for (let i = 0; i < w.index.length; i++) {
        const ix = w.index[i] % w.nx, iy = Math.floor(w.index[i] / w.nx) - CROP_SOUTH;
        if (iy < 0) continue;
        const v = Math.round(w.values[i * 12 + m0] * (1 - f) + w.values[i * 12 + m1] * f), o = ((rows - 1 - iy) * w.nx + ix) * 4;
        px[o] = LUT[v * 3]; px[o + 1] = LUT[v * 3 + 1]; px[o + 2] = LUT[v * 3 + 2]; px[o + 3] = 255;
      }
      sg.putImageData(img, 0, 0);
      const dpr = Math.min(2, window.devicePixelRatio || 1), cw = cv.clientWidth, ch = Math.round(cw * rows / w.nx);
      if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
      g.clearRect(0, 0, cv.width, cv.height);
      g.globalCompositeOperation = "source-over"; g.imageSmoothingEnabled = false; g.filter = "none";
      g.drawImage(small, 0, 0, cv.width, cv.height);
      g.globalCompositeOperation = "lighter"; g.imageSmoothingEnabled = true; g.filter = `blur(${Math.max(3, cv.width / 220)}px) brightness(1.15)`; g.globalAlpha = 0.4;
      g.drawImage(small, 0, 0, cv.width, cv.height);
      g.globalAlpha = 1; g.filter = "none"; g.globalCompositeOperation = "source-over";
    };
    const tick = (now: number) => {
      if (playing) { if (last) pos.current = (pos.current + (now - last) / MS_PER_MONTH) % 12; last = now; }
      draw(pos.current);
      const m = Math.round(pos.current) % 12;
      if (m !== shown) { shown = m; setMonth(m); }
      if (playing) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const ro = new ResizeObserver(() => { if (!playing) draw(pos.current); });
    ro.observe(cv);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [ready, playing, seek]);

  function pick(e: React.MouseEvent<HTMLCanvasElement>) {
    const w = world.current; if (!w || !onPick) return;
    const r = e.currentTarget.getBoundingClientRect(), rows = w.ny - CROP_SOUTH;
    const ix = (e.clientX - r.left) / r.width * w.nx, iy = (1 - (e.clientY - r.top) / r.height) * rows + CROP_SOUTH;
    const x = ix * w.cellKm - Math.PI * R_KM * COS30, y = iy * w.cellKm - R_KM / COS30;
    const lon = x / (R_KM * COS30) * 180 / Math.PI, lat = Math.asin(Math.max(-1, Math.min(1, y * COS30 / R_KM))) * 180 / Math.PI;
    onPick(Math.round(lat * 100) / 100, Math.round(Math.max(-180, Math.min(180, lon)) * 100) / 100);
  }
  function jump(m: number) { pos.current = m; setPlaying(false); setMonth(m); setSeek(k => k + 1); }

  if (failed) return null;
  const b = baseline ?? [2003, 2025];
  return <section className="world" aria-label={t.kicker}>
    <div className="world-head">
      <div>
        <div className="world-kicker">{t.kicker}</div>
        <div className="world-month" aria-live="off">{MONTHS_LONG[lang][month].replace(/^./, c => c.toUpperCase())}</div>
        <p className="world-sub">{t.sub(b[0], b[1])}</p>
      </div>
      <div className="world-scale" aria-hidden="true"><span>{t.low}</span><i /><span>{t.high}</span></div>
    </div>
    <canvas ref={canvas} className={`world-canvas${onPick ? " pickable" : ""}${ready ? " ready" : ""}`} role="img" aria-label={t.alt} onClick={pick} />
    <div className="world-controls">
      <button className="world-play" onClick={() => setPlaying(p => !p)} aria-label={playing ? t.pause : t.play} disabled={!ready}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
      <div className="world-months" role="group" aria-label={t.months}>
        {MONTHS[lang].map((name, m) => <button key={m} aria-pressed={m === month} onClick={() => jump(m)} disabled={!ready}>{name}</button>)}
      </div>
      {onPick && <span className="world-hint">{t.hint}</span>}
    </div>
  </section>;
}
