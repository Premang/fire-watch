// @ts-expect-error Explicit source extension supports the Node test runner.
import { canonicalIncidentId, HISTORY_NOTE, nonnegative, sourceTime, textField, US_STATES, validateGeometry } from "./perimeters.ts";
import type { PerimeterFeature, PerimeterHistory, PerimeterSummary, StoredVersionSummary } from "./perimeters.ts";

/** Small structural interface keeps storage logic independent of the Workers runtime. */
export interface PerimeterBucket {
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>;
  put(key: string, value: string, options?: { onlyIf?: Headers; customMetadata?: Record<string, string>; httpMetadata?: { contentType: string } }): Promise<unknown>;
  list(options: { prefix: string; limit: number; cursor?: string; include: ["customMetadata"] }): Promise<{ objects: { key: string; customMetadata?: Record<string, string> }[]; truncated: boolean; cursor?: string }>;
}
export type StoredPerimeter = { schemaVersion: 1; incidentId: string; versionId: string; observedAt: string; feature: PerimeterFeature };
const MAX_STORED_BYTES = 8_000_000;
const VERSION = /^[a-f0-9]{64}$/;
function prefix(id: string): string { const clean = canonicalIncidentId(id); if (!clean) throw new Error("Invalid incident ID"); return `perimeters/v1/${clean.slice(1, -1).toLowerCase()}/`; }
function recordKey(id: string, version: string): string { if (!VERSION.test(version)) throw new Error("Invalid version ID"); return `${prefix(id)}${version}.json`; }
export function validVersionId(value: string): boolean { return VERSION.test(value); }
function allowedSourceUrl(sourceId: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  const base = sourceId === "nifc" ? "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?" : "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/CA_Perimeters_NIFC_FIRIS_public_view/FeatureServer/0/query?";
  return value.startsWith(base) ? value : null;
}
/** Pick public allowlisted fields. No upstream attributes or arbitrary extra metadata persist. */
export function validateStoredFeature(value: unknown, expectedId?: string): PerimeterFeature | null {
  if (!value || typeof value !== "object") return null;
  const feature = value as { type?: unknown; geometry?: unknown; properties?: Record<string, unknown> };
  const p = feature.properties; const shape = validateGeometry(feature.geometry);
  if (feature.type !== "Feature" || !p || !shape) return null;
  const id = canonicalIncidentId(p.id); const expected = expectedId ? canonicalIncidentId(expectedId) : null;
  if (!id || (expectedId && id !== expected) || (p.sourceId !== "nifc" && p.sourceId !== "calfire")) return null;
  const name = textField(p.name); const perimeterId = textField(p.perimeterId); const state = textField(p.state); const source = textField(p.source);
  const sourceUrl = allowedSourceUrl(p.sourceId, p.sourceUrl);
  if (!name || !perimeterId || !perimeterId.startsWith(`${p.sourceId}:`) || !state || !US_STATES.has(state) || !source || !sourceUrl || !["mapped", "approximate", "unknown"].includes(String(p.quality))) return null;
  const percent = nonnegative(p.containment);
  const properties: PerimeterSummary = {
    id, perimeterId, name, state, source, sourceId: p.sourceId, sourceUrl,
    lon: (shape.bounds.west + shape.bounds.east) / 2, lat: (shape.bounds.south + shape.bounds.north) / 2,
    bounds: shape.bounds, acres: nonnegative(p.acres), containment: percent !== null && percent <= 100 ? percent : null,
    updatedAt: sourceTime(p.updatedAt), discoveredAt: sourceTime(p.discoveredAt), capturedAt: sourceTime(p.capturedAt), editedAt: sourceTime(p.editedAt), sourceUpdatedAt: sourceTime(p.sourceUpdatedAt),
    mapMethod: textField(p.mapMethod), quality: p.quality as PerimeterSummary["quality"],
  };
  return { type: "Feature", geometry: shape.geometry, properties };
}
/** Incident report edits and retrieval times do not create new geometry observations. */
export async function perimeterVersionId(feature: PerimeterFeature): Promise<string> {
  const f = validateStoredFeature(feature); if (!f) throw new Error("Invalid public perimeter feature");
  const p = f.properties;
  const bytes = new TextEncoder().encode(JSON.stringify({ incidentId: p.id, sourceId: p.sourceId, perimeterId: p.perimeterId, geometry: f.geometry, capturedAt: p.capturedAt, editedAt: p.editedAt, sourceUpdatedAt: p.sourceUpdatedAt, mapMethod: p.mapMethod, quality: p.quality }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function summary(record: StoredPerimeter): StoredVersionSummary {
  const p = record.feature.properties;
  return { versionId: record.versionId, observedAt: record.observedAt, capturedAt: p.capturedAt, editedAt: p.editedAt, sourceUpdatedAt: p.sourceUpdatedAt, source: p.source, sourceId: p.sourceId, mapMethod: p.mapMethod, quality: p.quality, bounds: p.bounds };
}
export async function savePerimeterVersion(bucket: PerimeterBucket, feature: PerimeterFeature, observedAt: string): Promise<string> {
  const safe = validateStoredFeature(feature); const observed = sourceTime(observedAt);
  if (!safe || !observed) throw new Error("Invalid perimeter observation");
  const versionId = await perimeterVersionId(safe); const key = recordKey(safe.properties.id, versionId);
  if (!await bucket.head(key)) {
    const record: StoredPerimeter = { schemaVersion: 1, incidentId: safe.properties.id, versionId, observedAt: observed, feature: safe };
    const body = JSON.stringify(record);
    if (new TextEncoder().encode(body).byteLength > MAX_STORED_BYTES) throw new Error("Perimeter is too large to retain safely");
    // Conditional immutable writes preserve the first observation during concurrent requests.
    await bucket.put(key, body, { onlyIf: new Headers({ "If-None-Match": "*" }), customMetadata: { summary: JSON.stringify(summary(record)) }, httpMetadata: { contentType: "application/json" } });
  }
  await bucket.put(`${prefix(safe.properties.id)}origin.json`, JSON.stringify({ startedAt: observed }), { onlyIf: new Headers({ "If-None-Match": "*" }), httpMetadata: { contentType: "application/json" } });
  return versionId;
}
export async function readPerimeterVersion(bucket: PerimeterBucket, id: string, versionId: string): Promise<StoredPerimeter | null> {
  const canonical = canonicalIncidentId(id); if (!canonical) throw new Error("Invalid incident ID");
  const object = await bucket.get(recordKey(canonical, versionId));
  if (!object) return null;
  if (object.size > MAX_STORED_BYTES) throw new Error("Stored perimeter exceeds the safe size limit");
  const data = JSON.parse(await object.text()) as Partial<StoredPerimeter>;
  const feature = validateStoredFeature(data.feature, canonical); const observedAt = sourceTime(data.observedAt);
  if (!feature || !observedAt || data.schemaVersion !== 1 || data.incidentId !== canonical || data.versionId !== versionId || await perimeterVersionId(feature) !== versionId) throw new Error("Stored perimeter failed validation");
  return { schemaVersion: 1, incidentId: canonical, versionId, observedAt, feature };
}
function validSummary(value: unknown, key: string, incidentPrefix: string): StoredVersionSummary | null {
  if (!value || typeof value !== "object") return null;
  const s = value as StoredVersionSummary;
  if (!VERSION.test(s.versionId ?? "") || key !== `${incidentPrefix}${s.versionId}.json` || !sourceTime(s.observedAt) || !["nifc", "calfire"].includes(s.sourceId) || !["mapped", "approximate", "unknown"].includes(s.quality)) return null;
  const b = s.bounds;
  if (!b || ![b.west, b.east, b.north, b.south].every(Number.isFinite) || b.west < -180 || b.east > 180 || b.south < -90 || b.north > 90 || b.west >= b.east || b.south >= b.north) return null;
  return { versionId: s.versionId, observedAt: sourceTime(s.observedAt)!, capturedAt: sourceTime(s.capturedAt), editedAt: sourceTime(s.editedAt), sourceUpdatedAt: sourceTime(s.sourceUpdatedAt), source: textField(s.source) ?? "Official perimeter", sourceId: s.sourceId, mapMethod: textField(s.mapMethod), quality: s.quality, bounds: b };
}
export async function listPerimeterVersions(bucket: PerimeterBucket, id: string): Promise<{ versions: StoredVersionSummary[]; history: PerimeterHistory }> {
  const incidentPrefix = prefix(id);
  const versions: StoredVersionSummary[] = []; let cursor: string | undefined; let truncated = false;
  // Bounded pagination; R2 is durable but a single HTTP response stays small.
  for (let page = 0; page < 3; page++) {
    const result = await bucket.list({ prefix: incidentPrefix, limit: 1000, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
    for (const object of result.objects) {
      try {
        const metadata = object.customMetadata?.summary;
        if (!metadata || metadata.length > 3000) continue;
        const candidate = validSummary(JSON.parse(metadata), object.key, incidentPrefix);
        if (candidate) versions.push(candidate);
      } catch { /* Malformed metadata is never exposed as a valid historical observation. */ }
    }
    truncated = result.truncated;
    if (!result.truncated || !result.cursor) break;
    cursor = result.cursor;
  }
  versions.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || (b.capturedAt ?? b.sourceUpdatedAt ?? b.editedAt ?? "").localeCompare(a.capturedAt ?? a.sourceUpdatedAt ?? a.editedAt ?? "") || a.versionId.localeCompare(b.versionId));
  const origin = await bucket.get(`${incidentPrefix}origin.json`);
  const startedAt = origin && origin.size < 1024 ? sourceTime((JSON.parse(await origin.text()) as { startedAt?: unknown }).startedAt) : null;
  return { versions: versions.slice(0, 100), history: { status: "available", startedAt: startedAt ?? versions.at(-1)?.observedAt ?? null, note: HISTORY_NOTE, truncated: truncated || versions.length > 100 } };
}
