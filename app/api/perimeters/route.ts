import { canonicalIncidentId, HISTORY_NOTE, PERIMETER_WARNING } from "@/lib/perimeters";
import type { PerimeterDetail, PerimeterIndex } from "@/lib/perimeters";
import { fetchPerimeterDetail, fetchPerimeterIndex, PerimeterSourceError } from "@/lib/perimeters-source";
import { listPerimeterVersions, readPerimeterVersion, savePerimeterVersion, validVersionId } from "@/lib/perimeters-store";
import type { PerimeterBucket } from "@/lib/perimeters-store";

const TTL = 300_000;
type CurrentDetail = Awaited<ReturnType<typeof fetchPerimeterDetail>>;
let indexCache: { at: number; data: PerimeterIndex } | null = null;
let indexPending: Promise<PerimeterIndex> | null = null;
const detailCache = new Map<string, { at: number; data: CurrentDetail }>();
const detailPending = new Map<string, Promise<CurrentDetail>>();
async function storage(): Promise<PerimeterBucket | null> {
  try {
    const { env } = await import("cloudflare:workers");
    return ((env as { BUCKET?: R2Bucket }).BUCKET as unknown as PerimeterBucket) ?? null;
  } catch { return null; }
}
async function currentDetail(id: string): Promise<CurrentDetail> {
  const cached = detailCache.get(id);
  if (cached && Date.now() - cached.at < TTL) return cached.data;
  let pending = detailPending.get(id);
  if (!pending) {
    pending = fetchPerimeterDetail(id).then(data => {
      detailCache.delete(id);
      detailCache.set(id, { at: Date.now(), data });
      if (detailCache.size > 12) detailCache.delete(detailCache.keys().next().value!);
      return data;
    }).finally(() => detailPending.delete(id));
    detailPending.set(id, pending);
  }
  return pending;
}
function response(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": status === 200 ? "private, max-age=60" : "no-store" } }); }
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const idInput = params.get("id"), version = params.get("version");
  if ((idInput !== null && !canonicalIncidentId(idInput)) || (version !== null && (!idInput || !validVersionId(version)))) return response({ error: "Provide a valid IRWIN incident UUID and, optionally, a 64-character saved version ID." }, 400);
  if ([...params.keys()].some(key => key !== "id" && key !== "version")) return response({ error: "Unsupported query parameter." }, 400);
  try {
    if (!idInput) {
      if (!indexCache || Date.now() - indexCache.at >= TTL) {
        indexPending ??= fetchPerimeterIndex().then(data => { indexCache = { at: Date.now(), data }; return data; }).finally(() => { indexPending = null; });
        await indexPending;
      }
      return response(indexCache!.data);
    }
    const id = canonicalIncidentId(idInput)!;
    const bucket = await storage();
    if (version) {
      if (!bucket) return response({ error: "Saved perimeter history is currently unavailable.", incidentId: id }, 503);
      const saved = await readPerimeterVersion(bucket, id, version);
      if (!saved) return response({ error: "This saved version does not exist for the selected incident.", incidentId: id }, 404);
      const history = await listPerimeterVersions(bucket, id);
      const data: PerimeterDetail = { incidentId: id, perimeters: [saved.feature], preferred: saved.feature, ...history, fetchedAt: new Date().toISOString(), capturedByAppAt: saved.observedAt, selectedVersionId: version, sources: [], partial: false, warning: PERIMETER_WARNING + " This is a saved observation, not a new agency update." };
      return response(data);
    }
    const current = await currentDetail(id);
    const data: PerimeterDetail = { ...current, versions: [], history: { status: "unavailable", startedAt: null, note: HISTORY_NOTE } };
    if (bucket) {
      try {
        // Preserve complete source geometry only; simplified index shapes are never archived.
        for (const feature of current.perimeters) await savePerimeterVersion(bucket, feature, current.fetchedAt);
        Object.assign(data, await listPerimeterVersions(bucket, id));
      } catch {
        data.warning += " Current agency geometry is available, but durable history could not be saved or read.";
      }
    } else data.warning += " Durable history storage is unavailable in this environment.";
    return response(data);
  } catch (error) {
    return response({ error: error instanceof PerimeterSourceError ? error.message : "The requested perimeter data could not be loaded. Please retry shortly.", incidentId: idInput ? canonicalIncidentId(idInput) : null, perimeters: [], incidents: [], fetchedAt: new Date().toISOString(), sources: error instanceof PerimeterSourceError ? error.sources : [], warning: "Perimeter availability is unknown while required sources or saved history are unavailable." }, 503);
  }
}
