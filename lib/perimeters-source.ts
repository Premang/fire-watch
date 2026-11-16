// Explicit .ts suffix also permits direct Node verification without a bundler.
// @ts-expect-error TypeScript's app bundler resolves this source import.
import { canonicalIncidentId, comparePerimeters, finite, mappingQuality, nonnegative, PERIMETER_WARNING, sourceTime, textField, US_STATES, validateGeometry } from "./perimeters.ts";
import type { PerimeterDetail, PerimeterFeature, PerimeterIndex, PerimeterSourceStatus, PerimeterSummary } from "./perimeters.ts";

/** These are fixed public agency endpoints, never supplied by the client.
 * NIFC item d1c32af3212341869b3c810f1a215824; CA item 025fb2ea05f14890b2b11573341b5b18.
 * NIFC's current view applies public/approved/visible and incident report fall-off rules.
 * CA displayStatus is a display setting, so exact linkage to NIFC current incidents is required. */
export const NIFC_PERIMETERS = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0";
export const NIFC_INCIDENTS = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0";
export const CALFIRE_PERIMETERS = "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/CA_Perimeters_NIFC_FIRIS_public_view/FeatureServer/0";
const NIFC_FIELDS = "OBJECTID,GlobalID,poly_IRWINID,poly_IncidentName,poly_MapMethod,poly_GISAcres,poly_Acres_AutoCalc,poly_DateCurrent,poly_PolygonDateTime,poly_Source,attr_IrwinID,attr_IncidentName,attr_POOState,attr_IncidentSize,attr_PercentContained,attr_FireDiscoveryDateTime,attr_ModifiedOnDateTime_dt,attr_IncidentTypeCategory,attr_ActiveFireCandidate";
const CA_FIELDS = "OBJECTID,GlobalID,type,source,poly_DateCurrent,mission,incident_name,incident_number,area_acres,description,FireDiscoveryDate,EditDate,displayStatus";
const INCIDENT_FIELDS = "IrwinID,IncidentName,POOState,IncidentSize,PercentContained,ModifiedOnDateTime_dt,FireDiscoveryDateTime,ActiveFireCandidate,IncidentTypeCategory,UniqueFireIdentifier";
const DEFINITIONS = [
  { id: "nifc", name: "NIFC WFIGS current perimeters", url: NIFC_PERIMETERS },
  { id: "calfire", name: "CAL FIRE / NIFC / FIRIS public perimeters", url: CALFIRE_PERIMETERS },
  { id: "nifc-incidents", name: "NIFC current incidents (California linkage)", url: NIFC_INCIDENTS },
];
type Attributes = Record<string, unknown>;
type RawFeature = { properties?: Attributes; geometry?: unknown; attributes?: Attributes };
type RawCollection = { features: RawFeature[]; exceededTransferLimit?: boolean; properties?: { exceededTransferLimit?: boolean } };
export type CurrentIncident = { id: string; uniqueFireIdentifier: string | null; name: string; state: string; acres: number | null; containment: number | null; updatedAt: string | null; discoveredAt: string | null };
export class PerimeterSourceError extends Error {
  sources: PerimeterSourceStatus[];
  constructor(sources: PerimeterSourceStatus[]) { super("Official perimeter sources are unavailable. Boundary availability is unknown."); this.sources = sources; }
}
function containment(value: unknown): number | null { const n = nonnegative(value); return n !== null && n <= 100 ? n : null; }
function recordUrl(source: string, field: string, value: string): string {
  const url = new URL(`${source}/query`);
  url.search = new URLSearchParams({ f: "geojson", where: `${field}='${value.replaceAll("'", "''")}'`, outFields: "*", returnGeometry: "true", outSR: "4326" }).toString();
  return url.toString();
}
export function normalizeNifc(feature: RawFeature): PerimeterFeature | null {
  const a = feature.properties ?? feature.attributes;
  if (!a || a.attr_IncidentTypeCategory !== "WF" || a.attr_ActiveFireCandidate !== 1) return null;
  const id = canonicalIncidentId(a.attr_IrwinID) ?? canonicalIncidentId(a.poly_IRWINID);
  // A conflicting join must not attribute one incident's polygon to another.
  const polygonId = canonicalIncidentId(a.poly_IRWINID);
  if (!id || (polygonId && polygonId !== id)) return null;
  const state = textField(a.attr_POOState)?.replace(/^US-/, "") ?? "";
  const shape = validateGeometry(feature.geometry);
  const name = textField(a.attr_IncidentName) ?? textField(a.poly_IncidentName);
  const recordId = textField(a.GlobalID) ?? (finite(a.OBJECTID) !== null ? String(a.OBJECTID) : null);
  if (!shape || !name || !recordId || !US_STATES.has(state)) return null;
  const mapMethod = textField(a.poly_MapMethod);
  const properties: PerimeterSummary = {
    id, perimeterId: `nifc:${recordId}`, name, state,
    lon: (shape.bounds.west + shape.bounds.east) / 2, lat: (shape.bounds.south + shape.bounds.north) / 2,
    acres: nonnegative(a.poly_GISAcres) ?? nonnegative(a.poly_Acres_AutoCalc) ?? nonnegative(a.attr_IncidentSize),
    containment: containment(a.attr_PercentContained), updatedAt: sourceTime(a.attr_ModifiedOnDateTime_dt), discoveredAt: sourceTime(a.attr_FireDiscoveryDateTime),
    bounds: shape.bounds, capturedAt: sourceTime(a.poly_PolygonDateTime), editedAt: sourceTime(a.poly_DateCurrent), sourceUpdatedAt: sourceTime(a.poly_DateCurrent),
    mapMethod, source: "NIFC WFIGS", sourceId: "nifc", sourceUrl: recordUrl(NIFC_PERIMETERS, "poly_IRWINID", id), quality: mappingQuality(mapMethod),
  };
  return { type: "Feature", geometry: shape.geometry, properties };
}
export function normalizeIncident(feature: RawFeature): CurrentIncident | null {
  const a = feature.properties ?? feature.attributes;
  if (!a || a.IncidentTypeCategory !== "WF" || a.ActiveFireCandidate !== 1) return null;
  const id = canonicalIncidentId(a.IrwinID); const name = textField(a.IncidentName);
  const state = textField(a.POOState)?.replace(/^US-/, "") ?? "";
  if (!id || !name || state !== "CA") return null;
  return { id, name, state, uniqueFireIdentifier: textField(a.UniqueFireIdentifier), acres: nonnegative(a.IncidentSize), containment: containment(a.PercentContained), updatedAt: sourceTime(a.ModifiedOnDateTime_dt), discoveredAt: sourceTime(a.FireDiscoveryDateTime) };
}
export function normalizeCalifornia(feature: RawFeature, incidents: CurrentIncident[]): PerimeterFeature | null {
  const a = feature.properties ?? feature.attributes;
  if (!a || a.displayStatus !== "Active") return null;
  const keys = [textField(a.incident_number), textField(a.mission)].filter((v): v is string => !!v);
  const ids = keys.map(canonicalIncidentId).filter((v): v is string => !!v);
  const matches = incidents.filter(incident => ids.includes(incident.id) || (incident.uniqueFireIdentifier !== null && keys.some(k => k.toUpperCase() === incident.uniqueFireIdentifier!.toUpperCase())));
  if (matches.length !== 1) return null;
  const incident = matches[0]; const shape = validateGeometry(feature.geometry);
  const recordId = textField(a.GlobalID) ?? (finite(a.OBJECTID) !== null ? String(a.OBJECTID) : null);
  if (!shape || !recordId) return null;
  const source = textField(a.source) ?? "CAL FIRE public perimeter layer";
  const description = textField(a.description, 500) ?? "";
  const mapMethod = /auto.?generated|approximate|hand sketch/i.test(description) ? "Approximate / automated perimeter" : /CAL FIRE INTEL FLIGHT DATA/i.test(source) ? "CAL FIRE aerial intelligence" : /FIRIS/i.test(source) ? "FIRIS aerial infrared" : null;
  const properties: PerimeterSummary = {
    id: incident.id, perimeterId: `calfire:${recordId}`, name: incident.name, state: incident.state,
    lon: (shape.bounds.west + shape.bounds.east) / 2, lat: (shape.bounds.south + shape.bounds.north) / 2,
    acres: nonnegative(a.area_acres) ?? incident.acres, containment: incident.containment, updatedAt: incident.updatedAt, discoveredAt: incident.discoveredAt,
    bounds: shape.bounds,
    // This layer provides no documented polygon capture field. Do not invent one.
    capturedAt: null, editedAt: sourceTime(a.EditDate), sourceUpdatedAt: sourceTime(a.poly_DateCurrent),
    mapMethod, source, sourceId: "calfire", sourceUrl: recordUrl(CALFIRE_PERIMETERS, "GlobalID", recordId), quality: mappingQuality(mapMethod),
  };
  return { type: "Feature", geometry: shape.geometry, properties };
}
async function query(source: string, where: string, fields: string, signal: AbortSignal, overview: boolean, limit = 1000): Promise<RawCollection> {
  const url = new URL(`${source}/query`);
  url.search = new URLSearchParams({
    f: "geojson", where, outFields: fields, returnGeometry: "true", outSR: "4326", resultRecordCount: String(limit),
    ...(overview ? { maxAllowableOffset: "0.0005", geometryPrecision: "5" } : {}),
    orderByFields: source === NIFC_PERIMETERS ? "poly_PolygonDateTime DESC" : source === CALFIRE_PERIMETERS ? "poly_DateCurrent DESC" : "ModifiedOnDateTime_dt DESC",
  }).toString();
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Agency service returned HTTP ${response.status}`);
  if (!response.body) throw new Error("Agency service returned an empty body");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ""; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 20_000_000) { await reader.cancel(); throw new Error("Agency response exceeded the safe download limit"); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  const data = JSON.parse(text) as RawCollection & { error?: unknown; type?: string };
  if (data.error || data.type !== "FeatureCollection" || !Array.isArray(data.features) || data.features.length > limit) throw new Error("Agency service returned an invalid perimeter response");
  return data;
}
function health(id: string, result: PromiseSettledResult<unknown>): PerimeterSourceStatus {
  const def = DEFINITIONS.find(s => s.id === id)!;
  return result.status === "fulfilled" ? { ...def, status: "ok" } : { ...def, status: "error", error: result.reason instanceof Error && result.reason.name === "TimeoutError" ? "The agency request timed out." : "The agency response could not be retrieved or validated." };
}
function isTruncated(data: RawCollection): boolean { return data.exceededTransferLimit === true || data.properties?.exceededTransferLimit === true; }
function uniqueFeatures(features: PerimeterFeature[]): PerimeterFeature[] {
  return [...new Map(features.map(feature => [feature.properties.perimeterId, feature])).values()].sort((a, b) => comparePerimeters(a.properties, b.properties));
}
export async function fetchPerimeterIndex(): Promise<PerimeterIndex> {
  const signal = AbortSignal.timeout(18_000);
  const [national, california, linkage] = await Promise.allSettled([
    query(NIFC_PERIMETERS, "attr_IncidentTypeCategory='WF' AND attr_ActiveFireCandidate=1 AND attr_POOState LIKE 'US-%'", NIFC_FIELDS, signal, true),
    query(CALFIRE_PERIMETERS, "displayStatus='Active'", CA_FIELDS, signal, true, 500),
    query(NIFC_INCIDENTS, "IncidentTypeCategory='WF' AND ActiveFireCandidate=1 AND POOState='US-CA'", INCIDENT_FIELDS, signal, true, 500),
  ]);
  const sources = [health("nifc", national), health("calfire", california), health("nifc-incidents", linkage)];
  if (national.status === "rejected" && (california.status === "rejected" || linkage.status === "rejected")) throw new PerimeterSourceError(sources);
  const current = linkage.status === "fulfilled" ? linkage.value.features.map(normalizeIncident).filter((v): v is CurrentIncident => !!v) : [];
  const nationalFeatures = national.status === "fulfilled" ? national.value.features.map(normalizeNifc).filter((v): v is PerimeterFeature => !!v) : [];
  const caFeatures = california.status === "fulfilled" && linkage.status === "fulfilled" ? california.value.features.map(f => normalizeCalifornia(f, current)).filter((v): v is PerimeterFeature => !!v) : [];
  const best = new Map<string, PerimeterSummary>();
  for (const feature of uniqueFeatures([...nationalFeatures, ...caFeatures])) if (!best.has(feature.properties.id)) best.set(feature.properties.id, feature.properties);
  const sorted = [...best.values()].sort(comparePerimeters);
  const truncated = sorted.length > 300 || [national, california, linkage].some(result => result.status === "fulfilled" && isTruncated(result.value));
  const partial = sources.some(s => s.status === "error") || truncated;
  const unlinked = california.status === "fulfilled" ? california.value.features.length - caFeatures.length : 0;
  return {
    incidents: sorted.slice(0, 300), fetchedAt: new Date().toISOString(), sources, partial, truncated,
    warning: PERIMETER_WARNING + " California display records are included only when exactly linked to a currently eligible NIFC wildfire by IRWIN ID or unique fire identifier." + (unlinked ? ` ${unlinked} California display records could not be safely linked or validated and were omitted.` : "") + (partial ? " Coverage is partial; inspect source status and any record limit." : "") + (truncated ? " The bounded index may omit additional agency records." : ""),
  };
}
export async function fetchPerimeterDetail(idInput: string): Promise<Pick<PerimeterDetail, "incidentId" | "perimeters" | "preferred" | "fetchedAt" | "sources" | "partial" | "warning">> {
  const id = canonicalIncidentId(idInput); if (!id) throw new Error("Invalid incident ID");
  const signal = AbortSignal.timeout(18_000);
  const [national, linkage] = await Promise.allSettled([
    query(NIFC_PERIMETERS, `attr_IncidentTypeCategory='WF' AND (poly_IRWINID='${id}' OR attr_IrwinID='${id}')`, NIFC_FIELDS, signal, false, 30),
    query(NIFC_INCIDENTS, `IncidentTypeCategory='WF' AND ActiveFireCandidate=1 AND POOState='US-CA' AND IrwinID='${id}'`, INCIDENT_FIELDS, signal, false, 2),
  ]);
  const current = linkage.status === "fulfilled" ? linkage.value.features.map(normalizeIncident).filter((v): v is CurrentIncident => !!v && v.id === id) : [];
  let california: PromiseSettledResult<RawCollection> | null = null;
  if (current.length) {
    const bare = id.slice(1, -1);
    const keys = [id, bare, bare.toLowerCase(), ...current.map(i => i.uniqueFireIdentifier).filter((v): v is string => !!v)];
    const values = [...new Set(keys)].map(k => `'${k.replaceAll("'", "''")}'`).join(",");
    [california] = await Promise.allSettled([query(CALFIRE_PERIMETERS, `displayStatus='Active' AND (incident_number IN (${values}) OR mission IN (${values}))`, CA_FIELDS, signal, false, 30)]);
  }
  const sources = [health("nifc", national), california ? health("calfire", california) : { ...DEFINITIONS[1], status: linkage.status === "fulfilled" ? "not-applicable" as const : "error" as const, ...(linkage.status === "rejected" ? { error: "Current California incident linkage is unavailable." } : {}) }, health("nifc-incidents", linkage)];
  if (national.status === "rejected" && california?.status !== "fulfilled") throw new PerimeterSourceError(sources);
  const features = uniqueFeatures([
    ...(national.status === "fulfilled" ? national.value.features.map(normalizeNifc).filter((v): v is PerimeterFeature => !!v && v.properties.id === id) : []),
    ...(california?.status === "fulfilled" ? california.value.features.map(f => normalizeCalifornia(f, current)).filter((v): v is PerimeterFeature => !!v && v.properties.id === id) : []),
  ]);
  const truncated = [national, california, linkage].some(result => result?.status === "fulfilled" && isTruncated(result.value));
  const partial = sources.some(s => s.status === "error") || truncated;
  return { incidentId: id, perimeters: features, preferred: features[0] ?? null, fetchedAt: new Date().toISOString(), sources, partial, warning: PERIMETER_WARNING + (partial ? " Some source records are unavailable or exceeded the bounded query limit; returned coverage may be incomplete." : "") };
}
