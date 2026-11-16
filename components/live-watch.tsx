"use client";

import { useState } from "react";
import IncidentWatch, { type IncidentWatchProps } from "./incident-watch";
import HotspotWatch from "./hotspot-watch";

export default function LiveWatch(props: IncidentWatchProps) {
  const [mode, setMode] = useState<"incident" | "hotspots">("incident");
  return <><div className="watch-mode segmented large" aria-label="Live watch mode"><button className={mode === "incident" ? "selected" : ""} onClick={() => setMode("incident")}>Mapped fire · live observations</button><button className={mode === "hotspots" ? "selected" : ""} onClick={() => setMode("hotspots")}>All hotspots · 24-hour replay</button></div>{mode === "incident" ? <IncidentWatch {...props} /> : <HotspotWatch {...props} />}</>;
}
