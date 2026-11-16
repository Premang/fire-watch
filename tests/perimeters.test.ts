import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Direct Node test runner executes TypeScript.
import { canonicalIncidentId, mappingQuality, validateGeometry } from "../lib/perimeters.ts";
// @ts-expect-error Direct Node test runner executes TypeScript.
import { CALFIRE_PERIMETERS, NIFC_INCIDENTS, NIFC_PERIMETERS, fetchPerimeterDetail, fetchPerimeterIndex, normalizeCalifornia, normalizeIncident, normalizeNifc, PerimeterSourceError } from "../lib/perimeters-source.ts";
// @ts-expect-error Direct Node test runner executes TypeScript.
import { listPerimeterVersions, perimeterVersionId, readPerimeterVersion, savePerimeterVersion, validateStoredFeature } from "../lib/perimeters-store.ts";
import type { PerimeterBucket } from "../lib/perimeters-store.ts";

const ID = "{730A7DAE-E447-4B05-BFF0-CCC274788DE5}";
const OTHER_ID = "{DC4342D9-B479-44F1-906C-8ABD42E1F59C}";
const geometry = { type: "MultiPolygon", coordinates: [
  [[[-123, 38], [-122, 38], [-122, 39], [-123, 39], [-123, 38]], [[-122.8, 38.2], [-122.8, 38.4], [-122.6, 38.4], [-122.6, 38.2], [-122.8, 38.2]]],
  [[[-121, 38], [-120, 38], [-120, 39], [-121, 39], [-121, 38]]],
] };
const attributes = {
  GlobalID: "example-record", poly_IRWINID: ID, attr_IrwinID: ID, attr_IncidentName: "Test fire", attr_POOState: "US-CA", attr_ActiveFireCandidate: 1,
  attr_IncidentTypeCategory: "WF", poly_MapMethod: "Mixed Methods", poly_GISAcres: 100, attr_PercentContained: 100,
  poly_PolygonDateTime: Date.parse("2026-10-18T20:00:00Z"), poly_DateCurrent: Date.parse("2026-10-19T20:00:00Z"), attr_ModifiedOnDateTime_dt: Date.parse("2026-10-22T20:00:00Z"),
};
function feature() { return normalizeNifc({ properties: attributes, geometry })!; }
function incident() { return normalizeIncident({ properties: { IrwinID: ID, IncidentName: "Test fire", POOState: "US-CA", ActiveFireCandidate: 1, IncidentTypeCategory: "WF", UniqueFireIdentifier: "2026-CABID-002147", PercentContained: 80 } })!; }
class MemoryBucket implements PerimeterBucket {
  values = new Map<string, { value: string; customMetadata?: Record<string, string> }>();
  async head(key: string) { const record = this.values.get(key); return record ? { size: record.value.length, customMetadata: record.customMetadata } : null; }
  async get(key: string) { const record = this.values.get(key); return record ? { size: record.value.length, text: async () => record.value } : null; }
  async put(key: string, value: string, options?: { onlyIf?: Headers; customMetadata?: Record<string, string> }) {
    if (options?.onlyIf?.get("If-None-Match") === "*" && this.values.has(key)) return null;
    this.values.set(key, { value, customMetadata: options?.customMetadata }); return { key };
  }
  async list(options: { prefix: string }) { return { objects: [...this.values].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => ({ key, customMetadata: value.customMetadata })), truncated: false }; }
}

test("incident UUID input is canonical and cannot inject SQL or storage paths", () => {
  assert.equal(canonicalIncidentId("730a7dae-e447-4b05-bff0-ccc274788de5"), ID);
  for (const value of ["../../secret", `${ID}' OR 1=1`, "{730a7dae-e447-4b05-bff0-ccc274788de5", "", null]) assert.equal(canonicalIncidentId(value), null);
});
test("geometry retains disjoint components and interior holes exactly", () => {
  const valid = validateGeometry(geometry)!;
  assert.deepEqual(valid.geometry, geometry);
  assert.deepEqual(valid.bounds, { west: -123, south: 38, east: -120, north: 39 });
  assert.equal(valid.geometry.coordinates.length, 2);
});
test("geometry rejects broken rings, nonfinite points and excessive vertices", () => {
  assert.equal(validateGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }), null);
  assert.equal(validateGeometry({ type: "Polygon", coordinates: [[[0, 0], [Infinity, 0], [1, 1], [0, 0]]] }), null);
  assert.equal(validateGeometry(geometry, 5), null);
});
test("source timestamps stay separate and current contained records are not silently hidden", () => {
  const value = feature();
  assert.equal(value.properties.containment, 100);
  assert.equal(value.properties.capturedAt, "2026-10-18T20:00:00.000Z");
  assert.equal(value.properties.editedAt, "2026-10-19T20:00:00.000Z");
  assert.equal(value.properties.updatedAt, "2026-10-22T20:00:00.000Z");
  assert.equal(normalizeNifc({ properties: { ...attributes, poly_IRWINID: OTHER_ID }, geometry }), null);
});
test("automatic/hand sketch shapes cannot be classified as measured mapping", () => {
  assert.equal(mappingQuality("Auto-generated for InFORM"), "approximate");
  assert.equal(mappingQuality("Hand Sketch"), "approximate");
  assert.equal(mappingQuality("IR Image Interpretation"), "mapped");
  assert.equal(mappingQuality(null), "unknown");
});
test("California uses exact incident linkage and does not invent a capture timestamp", () => {
  const properties = { GlobalID: "aerial-record", displayStatus: "Active", incident_number: ID.slice(1, -1).toLowerCase(), source: "CAL FIRE INTEL FLIGHT DATA", poly_DateCurrent: Date.parse("2026-10-19T20:26:00Z"), incident_name: "Name ignored for linkage" };
  const ca = normalizeCalifornia({ properties, geometry }, [incident()])!;
  assert.equal(ca.properties.id, ID);
  assert.equal(ca.properties.capturedAt, null);
  assert.equal(ca.properties.editedAt, null);
  assert.equal(ca.properties.sourceUpdatedAt, "2026-10-19T20:26:00.000Z");
  assert.equal(ca.properties.quality, "mapped");
  assert.equal(normalizeCalifornia({ properties: { ...properties, incident_number: "unlinked", incident_name: "Test fire" }, geometry }, [incident()]), null);
  assert.ok(normalizeCalifornia({ properties: { ...properties, incident_number: "2026-CABID-002147" }, geometry }, [incident()]));
  assert.equal(normalizeCalifornia({ properties, geometry }, []), null);
});
test("version hash tracks geometry and capture metadata, not fetch or incident edit time", async () => {
  const base = feature(); const changedReport = structuredClone(base); changedReport.properties.updatedAt = "2026-10-23T00:00:00.000Z";
  assert.equal(await perimeterVersionId(base), await perimeterVersionId(changedReport));
  const changedCapture = structuredClone(base); changedCapture.properties.capturedAt = "2026-10-19T20:00:00.000Z";
  assert.notEqual(await perimeterVersionId(base), await perimeterVersionId(changedCapture));
});
test("durable versions are immutable, ownership checked, and first-seen time preserved", async () => {
  const bucket = new MemoryBucket(); const base = feature();
  const version = await savePerimeterVersion(bucket, base, "2026-10-22T20:00:00Z");
  await savePerimeterVersion(bucket, base, "2026-10-23T20:00:00Z");
  assert.equal(bucket.values.size, 2);
  const saved = await readPerimeterVersion(bucket, ID, version);
  assert.equal(saved?.observedAt, "2026-10-22T20:00:00.000Z");
  assert.deepEqual(saved?.feature.geometry, geometry);
  assert.equal(await readPerimeterVersion(bucket, OTHER_ID, version), null);
  const history = await listPerimeterVersions(bucket, ID);
  assert.equal(history.versions.length, 1); assert.equal(history.history.startedAt, "2026-10-22T20:00:00.000Z");
  assert.match(history.history.note, /not a complete earlier fire progression/);
});
test("storage strips unapproved properties and rejects tampered geometry", async () => {
  const base = feature(); Object.assign(base.properties, { arbitraryPrivateField: "must not persist" });
  assert.equal("arbitraryPrivateField" in validateStoredFeature(base)!.properties, false);
  const bucket = new MemoryBucket(); const version = await savePerimeterVersion(bucket, base, "2026-10-22T20:00:00Z");
  const key = [...bucket.values.keys()].find(k => k.endsWith(`${version}.json`))!;
  const record = bucket.values.get(key)!; const data = JSON.parse(record.value); data.feature.properties.capturedAt = "2026-10-20T00:00:00.000Z"; record.value = JSON.stringify(data);
  await assert.rejects(readPerimeterVersion(bucket, ID, version), /validation/);
});
test("healthy empty sources differ from source failure; successful partial sources are explicit", async () => {
  const original = globalThis.fetch;
  const empty = () => Response.json({ type: "FeatureCollection", features: [] });
  try {
    globalThis.fetch = async () => empty();
    const healthy = await fetchPerimeterIndex(); assert.equal(healthy.incidents.length, 0); assert.equal(healthy.partial, false);
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await assert.rejects(fetchPerimeterIndex(), PerimeterSourceError);
    globalThis.fetch = async input => String(input).startsWith(CALFIRE_PERIMETERS) ? new Response("unavailable", { status: 503 }) : empty();
    const partial = await fetchPerimeterIndex(); assert.equal(partial.partial, true); assert.equal(partial.sources.find(s => s.id === "calfire")?.status, "error");
    globalThis.fetch = async input => String(input).startsWith(NIFC_PERIMETERS) ? new Response("unavailable", { status: 503 }) : empty();
    // A healthy empty CA linkage service does not mean the national perimeter source worked.
    await assert.rejects(fetchPerimeterDetail(OTHER_ID), PerimeterSourceError);
    globalThis.fetch = async input => String(input).startsWith(NIFC_INCIDENTS) ? new Response("unavailable", { status: 503 }) : empty();
    const detail = await fetchPerimeterDetail(ID); assert.equal(detail.partial, true); assert.equal(detail.preferred, null);
  } finally { globalThis.fetch = original; }
});
