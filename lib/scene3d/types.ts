// Data contract for the 3D fire view. Everything here comes from measurements; the renderer adds the simulated flames and smoke.
export interface SceneFire {
  lon: number; lat: number;
  /** Fire radiative power, MW (0 when unknown). */
  frp: number;
  /** Hours before the pass being shown. 0 = detected on that pass (drawn burning); larger = detected earlier (drawn as burned ground). */
  ageHours: number;
}
export interface SceneData {
  /** Where the view is centred. */
  center: { lat: number; lon: number };
  /** Time of the satellite pass being shown, ISO 8601 UTC. Sets the sun and moon. */
  timeUTC: string;
  /** Wind at that hour: speed in m/s and the compass bearing it blows from. Null when no wind record was available. */
  wind: { speed: number; dirFrom: number; source: string } | null;
  fires: SceneFire[];
  place?: string;
  satellite?: string;
}
export type SceneQuality = "low" | "medium" | "high" | "film";
export interface SceneView { azimuth: number; pitch: number; distance: number; target?: [number, number] }
export interface SceneProgress { stage: string; done: number; total: number }
