import { getGoesFrame } from "@/lib/goes-frame";
import { parseGoesBounds } from "@/lib/goes-projection";
import { parseGoesKey, parseGoesPlatform } from "@/lib/goes-source";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "";
  let platform, bounds;
  try {
    platform = parseGoesPlatform(url.searchParams.get("platform"));
    bounds = parseGoesBounds(url.searchParams.get("bbox"));
    const metadata = parseGoesKey(key, platform);
    const age = Date.now() - Date.parse(metadata.scanStart);
    if (age < -5 * 60_000 || age > 6 * 3_600_000) throw new Error("Select a NOAA scan from the past six hours.");
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid GOES frame request." }, { status: 400 });
  }
  try {
    return Response.json(await getGoesFrame(platform, key, bounds), {
      headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "NOAA frame decoding failed." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
