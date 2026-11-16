"use client";

// Full-screen 3D view of a fire, rebuilt from satellite detections. lib/scene3d/engine.ts draws it; this component loads the data and shows what is measured and what is simulated.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Eye, Info, Mountain, Plane } from "lucide-react";
import type { FireScene, FireSceneInfo } from "@/lib/scene3d/engine";
import type { SceneQuality, SceneView } from "@/lib/scene3d/types";
import type { SceneResponse } from "@/lib/scene-data";
import { DEM_CREDIT, IMAGERY_CREDIT } from "@/lib/scene3d/tiles";

declare global { interface Window { __scene?: FireScene; __sceneReady?: boolean; __sceneError?: string; __film?: (frame: number, total: number, sub: number) => { image: string; altitude: number } } }
type Lang = "en" | "es";
const COMPASS = { en: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"], es: ["N", "NE", "E", "SE", "S", "SO", "O", "NO"] };
const T = {
  en: {
    kicker: "3D FIRE VIEW · REBUILT FROM SATELLITE DATA", pass: (sat: string, d: string, t: string, local: string) => `${sat} pass · ${d}, ${t} UTC (about ${local} local solar time)`,
    active: (n: number) => <><b>{n.toLocaleString()}</b> fire detections on this pass, drawn burning</>, earlier: (n: number) => <><b>{n.toLocaleString()}</b> earlier detections, drawn as burned ground</>,
    wind: (s: number, d: number, c: string) => <>Wind <b>{s.toFixed(1)} m/s</b> from <b>{Math.round(d)}° ({c})</b></>, noWind: "No wind record: the smoke direction is a placeholder",
    day: (e: number) => <>Sun <b>{Math.round(e)}°</b> above the horizon</>, night: (m: number) => <>Night pass · moon <b>{Math.round(m * 100)}%</b> lit</>, plume: (km: number) => <>Smoke top <b>about {km.toFixed(1)} km</b> <small>(estimated from fire power)</small></>,
    ground: "Ground view", overview: "Overview", fly: "Fly out", stop: "Stop", passLabel: "SATELLITE PASS", quality: "DETAIL", q: { low: "Low", medium: "Medium", high: "High" }, back: "Back to the atlas",
    legend: "What is measured, what is simulated", measured: "MEASURED", simulated: "SIMULATED",
    m: ["Shape of the land (elevation data)", "Ground colour (aerial and satellite photos, not taken on the day of the fire)", "Where fire was seen: each detection is one 375 m satellite pixel", "Wind at the hour of the pass", "Sun and moon position for that time and place"],
    s: ["Flames, smoke and embers", "The exact line of the fire between neighbouring detections", "Individual plants, placed where the photos show vegetation", "How high the smoke rises"],
    warning: "This is an illustration, not a camera image. Do not use it for safety or operational decisions.",
    hint: "Drag to look around · scroll or pinch to zoom · shift-drag to move", loading: "Loading the fire data", data: "Fire detections: NASA FIRMS (VIIRS 375 m)", plants: "Plants: Poly Haven (CC0)",
    stages: {} as Record<string, string>, failed: "The 3D view could not be shown.", coords: (la: number, lo: number) => `${Math.abs(la).toFixed(2)}°${la < 0 ? "S" : "N"}, ${Math.abs(lo).toFixed(2)}°${lo < 0 ? "W" : "E"}`,
  },
  es: {
    kicker: "VISTA 3D DEL FUEGO · RECONSTRUIDA CON DATOS SATELITALES", pass: (sat: string, d: string, t: string, local: string) => `Pasada de ${sat} · ${d}, ${t} UTC (cerca de las ${local}, hora solar local)`,
    active: (n: number) => <><b>{n.toLocaleString()}</b> detecciones de fuego en esta pasada, dibujadas ardiendo</>, earlier: (n: number) => <><b>{n.toLocaleString()}</b> detecciones anteriores, dibujadas como suelo quemado</>,
    wind: (s: number, d: number, c: string) => <>Viento <b>{s.toFixed(1)} m/s</b> desde <b>{Math.round(d)}° ({c})</b></>, noWind: "Sin registro de viento: la dirección del humo es una suposición",
    day: (e: number) => <>Sol a <b>{Math.round(e)}°</b> sobre el horizonte</>, night: (m: number) => <>Pasada nocturna · luna <b>{Math.round(m * 100)}%</b> iluminada</>, plume: (km: number) => <>Tope del humo <b>cerca de {km.toFixed(1)} km</b> <small>(estimado por la potencia del fuego)</small></>,
    ground: "Vista a ras del suelo", overview: "Vista general", fly: "Alejarse volando", stop: "Detener", passLabel: "PASADA DEL SATÉLITE", quality: "DETALLE", q: { low: "Bajo", medium: "Medio", high: "Alto" }, back: "Volver al atlas",
    legend: "Qué es medido y qué es simulado", measured: "MEDIDO", simulated: "SIMULADO",
    m: ["Forma del terreno (datos de elevación)", "Color del suelo (fotos aéreas y satelitales, no tomadas el día del fuego)", "Dónde se vio fuego: cada detección es un píxel satelital de 375 m", "Viento a la hora de la pasada", "Posición del sol y la luna para ese momento y lugar"],
    s: ["Llamas, humo y pavesas", "La línea exacta del fuego entre detecciones vecinas", "Cada planta, colocada donde las fotos muestran vegetación", "La altura que alcanza el humo"],
    warning: "Esto es una ilustración, no la imagen de una cámara. No la use para decisiones de seguridad ni operativas.",
    hint: "Arrastre para mirar · rueda o pellizco para acercar · mayús + arrastrar para moverse", loading: "Cargando los datos del fuego", data: "Detecciones de fuego: NASA FIRMS (VIIRS 375 m)", plants: "Plantas: Poly Haven (CC0)",
    stages: { "Loading terrain and imagery": "Cargando terreno e imágenes", "Building the landscape": "Construyendo el paisaje", "Planting vegetation": "Colocando la vegetación" } as Record<string, string>,
    failed: "No se pudo mostrar la vista 3D.", coords: (la: number, lo: number) => `${Math.abs(la).toFixed(2)}°${la < 0 ? "S" : "N"}, ${Math.abs(lo).toFixed(2)}°${lo < 0 ? "O" : "E"}`,
  },
};

export default function FireSceneView() {
  const canvas = useRef<HTMLCanvasElement>(null), sceneRef = useRef<FireScene | null>(null), flyRaf = useRef(0);
  const [lang, setLang] = useState<Lang>("en"), [film, setFilm] = useState(false);
  const [status, setStatus] = useState<{ stage: string; pct: number } | null>({ stage: "", pct: 0 }), [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<FireSceneInfo | null>(null), [data, setData] = useState<SceneResponse | null>(null);
  const [quality, setQuality] = useState<SceneQuality>("medium"), [flying, setFlying] = useState(false), [hint, setHint] = useState(true);
  const [legendOpen, setLegendOpen] = useState(true);
  const t = T[lang];

  useEffect(() => {
    let scene: FireScene | null = null, cancelled = false, detach = () => {};
    const q = new URLSearchParams(window.location.search), isFilm = q.get("film") === "1", slow = (navigator.hardwareConcurrency ?? 8) <= 4 || window.innerWidth < 700;
    const qual = (["low", "medium", "high", "film"].includes(q.get("quality") ?? "") ? q.get("quality") : isFilm ? "film" : slow ? "low" : "medium") as SceneQuality;
    const init = setTimeout(() => { setLang(q.get("lang") === "es" ? "es" : "en"); setFilm(isFilm); setQuality(qual); setLegendOpen(window.innerWidth >= 1100 && window.innerHeight >= 720); }, 0);
    (async () => {
      try {
        const res = await fetch(q.get("demo") ? `/scene3d/demo-${(q.get("demo") ?? "").replace(/[^a-z0-9-]/g, "")}.json` : `/api/scene?${q.toString()}`);
        if (!res.ok) throw new Error((await res.json().catch(() => null) as { error?: string } | null)?.error ?? `Could not load the fire data (${res.status}).`);
        const d = await res.json() as SceneResponse;
        const { createFireScene } = await import("@/lib/scene3d/engine");
        if (cancelled || !canvas.current) return;
        setData(d);
        scene = await createFireScene(canvas.current, d, { quality: qual, fixedSize: isFilm ? [Number(q.get("w")) || 1920, Number(q.get("h")) || 1080] : undefined, onProgress: p => setStatus({ stage: p.stage, pct: p.total > 1 ? p.done / p.total : 1 }) });
        if (cancelled) { scene.dispose(); return; }
        sceneRef.current = scene; setInfo(scene.info); setStatus(null);
        if (isFilm) { // deterministic frames for the recorded video: several sub-frames averaged for motion blur
          const s = scene, endLat = Number(q.get("endLat")), endLon = Number(q.get("endLon")), end = Number.isFinite(endLat) && q.get("endLat") ? { target: s.project(endLon, endLat), distance: Number(q.get("endDist")) || 55000 } : undefined;
          // "hook" path: longer at the ground with a sideways sweep, then up to a closer top view that keeps drifting outward.
          const hook = q.get("path") === "hook", style = hook ? { groundShare: 0.56, pan: Number(q.get("pan")) || 34, startDistance: Number(q.get("d0")) || 105, startPitch: 3.2 } : undefined, hold = Number(q.get("hold")) || 0;
          // rev=1 runs the camera path backwards (a dive from the top view to the ground) while the fire and smoke keep moving forwards.
          const rev = q.get("rev") === "1";
          const viewAt = (frame: number, total: number): SceneView => { const f = rev ? total - 1 - frame : frame, move = total - hold, v = s.flight(Math.max(0, Math.min(1, f / (move - 1))), end, style); return f > move - 1 ? { ...v, distance: v.distance * (1 + 0.0035 * (f - (move - 1))) } : v; };
          window.__film = (frame, total, sub) => { const views: SceneView[] = [], times: number[] = [];
            for (let k = 0; k < sub; k++) { const f = frame + (k + 0.5) / sub * 0.55; views.push(viewAt(f, total)); times.push(20 + f / 30); }
            s.renderAccumulated(views, times); const v = views[views.length - 1];
            return { image: canvas.current!.toDataURL("image/jpeg", 0.94), altitude: v.distance * Math.sin(v.pitch * Math.PI / 180) }; };
          (window as Window & { __filmView?: (f: number, total: number) => SceneView }).__filmView = viewAt;
        } else { detach = scene.attachControls(() => setHint(false)); scene.start(); }
        window.__scene = scene; window.__sceneReady = true;
      } catch (e) { const m = e instanceof Error ? e.message : String(e); window.__sceneError = m; setError(m); setStatus(null); }
    })();
    const onResize = () => scene?.resize();
    window.addEventListener("resize", onResize);
    return () => { cancelled = true; clearTimeout(init); cancelAnimationFrame(flyRaf.current); window.removeEventListener("resize", onResize); detach(); scene?.dispose(); sceneRef.current = null; window.__scene = undefined; window.__sceneReady = false; };
  }, []);

  const stopFly = useCallback(() => { cancelAnimationFrame(flyRaf.current); setFlying(false); }, []);
  const go = (which: "ground" | "overview") => { const s = sceneRef.current; if (!s) return; stopFly(); s.setView(which === "ground" ? s.ground : s.overview); };
  const fly = () => {
    const s = sceneRef.current; if (!s) return; if (flying) { stopFly(); return; }
    const t0 = performance.now(), step = (now: number) => { const u = Math.min(1, (now - t0) / 10000); s.setView(s.flight(u)); if (u < 1) flyRaf.current = requestAnimationFrame(step); else setFlying(false); };
    setFlying(true); setHint(false); flyRaf.current = requestAnimationFrame(step);
  };
  const reload = (k: string, v: string) => { const q = new URLSearchParams(window.location.search); q.set(k, v); window.location.search = q.toString(); };
  // Another pass of the same fire: pin the place, then ask for that pass by its time.
  const switchPass = (time: string) => { if (!data) return; const q = new URLSearchParams(window.location.search); for (const k of ["date", "month", "west", "south", "east", "north", "demo"]) q.delete(k);
    q.set("lat", data.center.lat.toFixed(4)); q.set("lon", data.center.lon.toFixed(4)); q.set("time", time); if (data.place) q.set("name", data.place); window.location.search = q.toString(); };

  const when = data ? new Date(data.timeUTC) : null, okTime = !!when && !Number.isNaN(when.getTime());
  const localSolar = okTime && data ? (() => { const h = ((when!.getUTCHours() + when!.getUTCMinutes() / 60 + data.center.lon / 15) % 24 + 24) % 24; return `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`; })() : "";
  const dateText = okTime ? when!.toLocaleDateString(lang === "es" ? "es" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "", timeText = okTime ? when!.toISOString().slice(11, 16) : "";
  if (film) return <div className="scene-root"><canvas ref={canvas} /></div>;

  return <div className="scene-root" lang={lang}>
    <canvas ref={canvas} onPointerDown={() => { if (flying) stopFly(); }} role="img" aria-label={`${t.kicker}. ${t.warning}`} />
    {data && info && <>
      <section className="scene-panel scene-card" aria-live="polite">
        <div className="scene-kicker">{t.kicker}</div>
        <h1>{data.place || t.coords(data.center.lat, data.center.lon)}</h1>
        <p className="scene-sub">{t.pass(data.satellite ?? "VIIRS", dateText, timeText, localSolar)}</p>
        <ul className="scene-facts">
          <li><span className="scene-dot" style={{ background: "#ff7a2f" }} /><span>{t.active(info.detections)}</span></li>
          {info.earlier > 0 && <li><span className="scene-dot" style={{ background: "#5a4a40" }} /><span>{t.earlier(info.earlier)}</span></li>}
          <li><span className="scene-dot" style={{ background: "#9fc2e8" }} /><span>{data.wind ? <>{t.wind(data.wind.speed, data.wind.dirFrom, COMPASS[lang][Math.round(data.wind.dirFrom / 45) % 8])} <small>· {data.wind.source}</small></> : t.noWind}</span></li>
          <li><span className="scene-dot" style={{ background: info.night ? "#8ea0c8" : "#f6d77a" }} /><span>{info.night ? t.night(info.moonLit) : t.day(info.sunElevation)}</span></li>
          <li><span className="scene-dot" style={{ background: "#c9ccd1" }} /><span>{t.plume(info.plumeTopM / 1000)}</span></li>
        </ul>
      </section>
      <nav className="scene-panel scene-actions" aria-label={t.kicker}>
        <button onClick={() => go("ground")}><Eye size={14} />{t.ground}</button>
        <button onClick={() => go("overview")}><Mountain size={14} />{t.overview}</button>
        <button onClick={fly} aria-pressed={flying}><Plane size={14} />{flying ? t.stop : t.fly}</button>
        {data.passes && data.passes.length > 1 && <><label htmlFor="scene-pass">{t.passLabel}</label>
          <select id="scene-pass" value={data.timeUTC} onChange={e => switchPass(e.target.value)}>
            {data.passes.slice(0, 24).map(p => <option key={p.time + p.satellite} value={p.time}>{p.time.slice(5, 10)} {p.time.slice(11, 16)} · {p.satellite} · {p.count}</option>)}
          </select></>}
        <label htmlFor="scene-quality">{t.quality}</label>
        <select id="scene-quality" value={quality === "film" ? "high" : quality} onChange={e => reload("quality", e.target.value)}>{(["low", "medium", "high"] as const).map(k => <option key={k} value={k}>{t.q[k]}</option>)}</select>
        <a href={lang === "es" ? "/?lang=es" : "/"}><ArrowLeft size={14} />{t.back}</a>
      </nav>
      <details className="scene-panel scene-legend" open={legendOpen} onToggle={e => setLegendOpen((e.target as HTMLDetailsElement).open)}>
        <summary><Info size={14} />{t.legend}</summary>
        <div className="scene-legend-body">
          <div><h2>{t.measured}</h2><ul>{t.m.map(x => <li key={x}>{x}</li>)}</ul></div>
          <div><h2>{t.simulated}</h2><ul>{t.s.map(x => <li key={x}>{x}</li>)}</ul></div>
          <p className="scene-warning" role="note">{t.warning}</p>
        </div>
      </details>
      <div className="scene-panel scene-credits">{t.data} · {IMAGERY_CREDIT} · {DEM_CREDIT} · {t.plants}{data.wind ? " · Open-Meteo" : ""}</div>
      <div className="scene-hint" style={{ opacity: hint ? 1 : 0 }}>{t.hint}</div>
    </>}
    {(status || error) && <div className="scene-loading" role="status">
      {error ? <div><p>{t.failed}</p><small>{error}</small><p style={{ marginTop: 18 }}><a href={lang === "es" ? "/?lang=es" : "/"}>← {t.back}</a></p></div>
        : <div><p>{(status?.stage && (t.stages[status.stage] ?? status.stage)) || t.loading}</p><div className="scene-bar"><i style={{ width: `${Math.round((status?.pct ?? 0) * 100)}%` }} /></div><small>{t.warning}</small></div>}
    </div>}
  </div>;
}
