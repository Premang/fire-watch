const sectors = {
  west: { base: "https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/psw/", label: "Pacific Southwest", satellite: "GOES-18", dimension: "600x600" },
  east: { base: "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/", label: "Contiguous United States", satellite: "GOES-19", dimension: "1250x750" },
} as const;
const products = {
  fire: { directory: "FireTemperature", title: "Fire Temperature RGB" },
  geocolor: { directory: "GEOCOLOR", title: "GeoColor" },
} as const;

function listingTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(`${value.trim()} UTC`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const sector = params.get("sector") ?? "east";
  const product = params.get("product") ?? "geocolor";
  if (sector !== "east" && sector !== "west") return Response.json({ error: "Unknown imagery sector." }, { status: 400 });
  if (product !== "fire" && product !== "geocolor") return Response.json({ error: "Unknown imagery product." }, { status: 400 });
  const config = sectors[sector];
  const selected = products[product];
  const base = `${config.base}${selected.directory}/`;
  try {
    const response = await fetch(base, { signal: AbortSignal.timeout(15000), cache: "no-store" });
    if (!response.ok) throw new Error("NOAA imagery is temporarily unavailable.");
    const html = await response.text();
    const entries = [...html.matchAll(/href="([0-9]{11}[^"<>/]+\.jpg)"[^>]*>[^<]*<\/a>\s*(\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2})?/g)]
      .filter((match) => match[1].endsWith(`${selected.directory}-${config.dimension}.jpg`))
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(-24);
    const frames = entries.map((match) => {
      const file = match[1];
      const year = Number(file.slice(0, 4)), day = Number(file.slice(4, 7));
      const hour = Number(file.slice(7, 9)), minute = Number(file.slice(9, 11));
      return { url: base + file, observedAt: new Date(Date.UTC(year, 0, day, hour, minute)).toISOString(), lastModified: listingTimestamp(match[2]) };
    });
    if (!frames.length) throw new Error("No recent NOAA frames were found for this product.");
    return Response.json({
      frames, sector: config.label, sectorKey: sector, satellite: config.satellite,
      product, title: selected.title, expectedCadenceMinutes: 5,
      source: base, sourceLastModified: response.headers.get("last-modified"), fetchedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=60" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "NOAA imagery is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
