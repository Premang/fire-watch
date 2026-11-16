import { fetchPredictionInputs, parsePredictionLocation, selectGfsCycle } from "@/lib/prediction-inputs";
import type { PredictionInputs } from "@/lib/prediction-inputs";

const cache = new Map<string, { at: number; value: PredictionInputs }>();
const pending = new Map<string, Promise<PredictionInputs>>();
export async function GET(request: Request) {
  const point = parsePredictionLocation(new URL(request.url).searchParams);
  if (!point) return Response.json({ error: "Provide finite lat/lon coordinates within the US coverage envelope (18–72° N, 180–60° W)." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const key = `${selectGfsCycle(Date.now())}:${point.lat},${point.lon}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 15 * 60_000) return Response.json(cached.value, { headers: { "Cache-Control": "private, max-age=60" } });
  try {
    let task = pending.get(key);
    if (!task) { task = fetchPredictionInputs(point.lat, point.lon).finally(() => pending.delete(key)); pending.set(key, task); }
    const value = await task;
    if (value.overallStatus !== "unavailable") { if (cache.size >= 40) cache.delete(cache.keys().next().value!); cache.set(key, { at: Date.now(), value }); }
    return Response.json(value, { status: value.overallStatus === "unavailable" ? 503 : 200, headers: { "Cache-Control": "private, max-age=60" } });
  } catch { return Response.json({ error: "Live model-input sources could not be reached. Input availability is unknown." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
