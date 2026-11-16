import { getGoesTimeline, parseGoesHours, parseGoesPlatform } from "@/lib/goes-source";

export async function GET(request: Request) {
  const url = new URL(request.url);
  let platform, hours;
  try {
    platform = parseGoesPlatform(url.searchParams.get("platform"));
    hours = parseGoesHours(url.searchParams.get("hours"));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid GOES request." }, { status: 400 });
  }
  try {
    return Response.json(await getGoesTimeline(platform, hours), {
      headers: { "Cache-Control": "public, max-age=20, s-maxage=30" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "NOAA timeline is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
