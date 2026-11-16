// Shared fire lines: a line entered on one screen is served to everyone viewing the same fire.
// Kept in memory only. That is enough for a demo on one server; it is lost on restart and is not
// shared between server instances. Durable storage would need the optional database binding.
type Line = [number, number][];
type Entry = { lines: Line[]; kinds: string[]; version: number; updatedAt: string };
const store = new Map<string, Entry>();
const MAX_KEYS = 200, MAX_LINES = 20, MAX_POINTS = 200;

const validKey = (key: unknown): key is string => typeof key === "string" && key.length > 0 && key.length <= 120 && /^[\w:./,\-]+$/.test(key);
function validLines(value: unknown): value is Line[] {
  return Array.isArray(value) && value.length <= MAX_LINES && value.every(line => Array.isArray(line) && line.length <= MAX_POINTS && line.every(point =>
    Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85));
}

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!validKey(key)) return Response.json({ error: "Provide a valid key." }, { status: 400 });
  const entry = store.get(key);
  return Response.json(entry ?? { lines: [], kinds: [], version: 0, updatedAt: null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let body: { key?: unknown; lines?: unknown; kinds?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "Send JSON." }, { status: 400 }); }
  if (!validKey(body.key) || !validLines(body.lines)) return Response.json({ error: "Provide a key and up to 20 lines of [lon, lat] points." }, { status: 400 });
  if (!store.has(body.key) && store.size >= MAX_KEYS) store.delete(store.keys().next().value!);
  const kinds = Array.isArray(body.kinds) && body.kinds.length === body.lines.length && body.kinds.every(k => typeof k === "string" && /^[a-z]{1,20}$/.test(k)) ? body.kinds as string[] : body.lines.map(() => "dozer");
  const entry: Entry = { lines: body.lines, kinds, version: (store.get(body.key)?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
  store.set(body.key, entry);
  return Response.json(entry, { headers: { "Cache-Control": "no-store" } });
}
