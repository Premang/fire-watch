/**
 * NIFC's authoritative current-incident view, verified via its ArcGIS item:
 * https://www.arcgis.com/home/item.html?id=4181a117dc9e43db8598533e29972015
 * The source applies ActiveFireCandidate and size-dependent 3/8/14-day fall-off
 * rules. An eligible incident is an administrative report, not proof of flames.
 */
const SOURCE = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0";
const DAY = 86_400_000;
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
const FIELDS = [
  "IrwinID", "IncidentName", "POOState", "IncidentSize", "PercentContained",
  "ModifiedOnDateTime_dt", "FireDiscoveryDateTime", "ActiveFireCandidate",
  "IncidentTypeCategory", "ContainmentDateTime", "ControlDateTime",
  "FireOutDateTime", "FinalFireReportApprovedDate",
].join(",");

type Incident = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  state: string;
  acres: number | null;
  containment: number | null;
  updatedAt: string | null;
  discoveredAt: string | null;
  url: string;
};
type Payload = {
  incidents: Incident[];
  fetchedAt: string;
  source: string;
  warning: string;
};
type Feature = {
  attributes?: Record<string, unknown>;
  geometry?: { x?: unknown; y?: unknown };
};
let cache: { at: number; data: Payload } | null = null;
let pending: Promise<Payload> | null = null;

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function timestamp(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && parsed > 0 && parsed < 8.64e15 ? parsed : null;
}
function normalize(feature: Feature, now: number): Incident | null {
  const a = feature.attributes;
  if (!a || a.IncidentTypeCategory !== "WF" || a.ActiveFireCandidate !== 1) return null;
  if ([a.ContainmentDateTime, a.ControlDateTime, a.FireOutDateTime, a.FinalFireReportApprovedDate].some(value => value !== null && value !== undefined)) return null;
  const id = typeof a.IrwinID === "string" ? a.IrwinID.trim() : "";
  const name = typeof a.IncidentName === "string" ? a.IncidentName.trim() : "";
  const state = typeof a.POOState === "string" ? a.POOState.replace(/^US-/, "") : "";
  const lat = number(feature.geometry?.y);
  const lon = number(feature.geometry?.x);
  if (!id || !name || !STATES.has(state) || lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const rawAcres = number(a.IncidentSize);
  const acres = rawAcres !== null && rawAcres >= 0 ? rawAcres : null;
  const rawContainment = number(a.PercentContained);
  if (rawContainment !== null && rawContainment >= 100) return null;
  const containment = rawContainment !== null && rawContainment >= 0 ? rawContainment : null;
  const updated = timestamp(a.ModifiedOnDateTime_dt);
  const discovered = timestamp(a.FireDiscoveryDateTime);
  const freshnessDays = acres !== null && acres > 100 ? 14 : acres !== null && acres >= 10 ? 8 : 3;
  const discoveryCutoff = Date.UTC(new Date(now).getUTCFullYear() - 1, 11, 1);
  // Reapply fall-off rules so an upstream view-refresh delay cannot expose old rows.
  if (updated === null || updated < now - freshnessDays * DAY || updated > now + 5 * 60_000 || discovered === null || discovered < discoveryCutoff || discovered > now) return null;
  const record = new URL(`${SOURCE}/query`);
  record.search = new URLSearchParams({
    f: "pjson", where: `IrwinID='${id.replaceAll("'", "''")}'`,
    outFields: FIELDS, returnGeometry: "true", outSR: "4326",
  }).toString();
  return {
    id, name, lat, lon, state, acres, containment,
    updatedAt: new Date(updated).toISOString(),
    discoveredAt: new Date(discovered).toISOString(),
    url: record.toString(),
  };
}

async function load(): Promise<Payload> {
  const query = new URL(`${SOURCE}/query`);
  query.search = new URLSearchParams({
    f: "json",
    where: "IncidentTypeCategory='WF' AND ActiveFireCandidate=1 AND POOState LIKE 'US-%' AND ContainmentDateTime IS NULL AND ControlDateTime IS NULL AND FireOutDateTime IS NULL AND FinalFireReportApprovedDate IS NULL AND (PercentContained < 100 OR PercentContained IS NULL)",
    outFields: FIELDS,
    returnGeometry: "true",
    outSR: "4326",
    orderByFields: "ModifiedOnDateTime_dt DESC",
    resultRecordCount: "300",
  }).toString();
  const response = await fetch(query, { cache: "no-store", signal: AbortSignal.timeout(18_000) });
  if (!response.ok) throw new Error(`NIFC returned HTTP ${response.status}`);
  const body = await response.json() as { error?: unknown; features?: Feature[]; exceededTransferLimit?: boolean };
  if (body.error || !Array.isArray(body.features)) throw new Error("NIFC returned an invalid incident response");
  const now = Date.now();
  const unique = new Map<string, Incident>();
  for (const feature of body.features) {
    const incident = normalize(feature, now);
    if (incident && !unique.has(incident.id)) unique.set(incident.id, incident);
  }
  const eligible = Array.from(unique.values());
  const truncated = eligible.length > 150 || body.exceededTransferLimit === true;
  const data: Payload = {
    incidents: eligible.slice(0, 150),
    fetchedAt: new Date(now).toISOString(),
    source: SOURCE,
    warning: "NIFC reports currently eligible wildfire incidents; locations are incident points, not fire boundaries or confirmation of active flames. Fully contained reports and stale records are excluded. Missing size or containment remains unknown." + (truncated ? " Showing up to 150 most recently updated eligible incidents." : ""),
  };
  cache = { at: now, data };
  return data;
}

export async function GET() {
  try {
    if (!cache || Date.now() - cache.at >= 300_000) {
      pending ??= load().finally(() => { pending = null; });
      await pending;
    }
    return Response.json(cache!.data, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch {
    return Response.json({
      error: "NIFC incident reports could not be reached. Please retry shortly.",
      incidents: [], fetchedAt: new Date().toISOString(), source: SOURCE,
      warning: "Incident availability is unknown while the source is unavailable.",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
