// Geometry helpers for the 3D fire view: a local metric frame, web-mercator tile maths, and low-precision sun and moon positions.
export const R_EARTH = 6371008.8;
const D2R = Math.PI / 180;

/** Local tangent frame in metres: x east, y up, z south. */
export class LocalFrame {
  readonly kx: number; readonly kz: number; readonly lat0: number; readonly lon0: number;
  constructor(lat0: number, lon0: number) { this.lat0 = lat0; this.lon0 = lon0; this.kz = R_EARTH * D2R; this.kx = this.kz * Math.cos(lat0 * D2R); }
  x(lon: number) { return (lon - this.lon0) * this.kx; }
  z(lat: number) { return -(lat - this.lat0) * this.kz; }
  lon(x: number) { return this.lon0 + x / this.kx; }
  lat(z: number) { return this.lat0 - z / this.kz; }
}
export const lonToTile = (lon: number, z: number) => (lon + 180) / 360 * 2 ** z;
export const latToTile = (lat: number, z: number) => (1 - Math.asinh(Math.tan(lat * D2R)) / Math.PI) / 2 * 2 ** z;

/** Unit vector for a compass azimuth (degrees clockwise from north) and elevation (degrees above the horizon). */
export function direction(azDeg: number, elDeg: number): [number, number, number] {
  const a = azDeg * D2R, e = elDeg * D2R;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}
const norm360 = (d: number) => ((d % 360) + 360) % 360;
function altAz(raDeg: number, decDeg: number, jd: number, lat: number, lon: number) {
  const n = jd - 2451545.0, gmst = norm360((18.697374558 + 24.06570982441908 * n) * 15), ha = (gmst + lon - raDeg) * D2R, la = lat * D2R, de = decDeg * D2R;
  const el = Math.asin(Math.sin(la) * Math.sin(de) + Math.cos(la) * Math.cos(de) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(de) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { azimuth: norm360(az / D2R), elevation: el / D2R };
}
/** Sun and moon position (about one degree accuracy, enough for lighting) and the lit fraction of the moon. */
export function sunMoon(date: Date, lat: number, lon: number) {
  const jd = date.getTime() / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L = norm360(280.460 + 0.9856474 * n), g = norm360(357.528 + 0.9856003 * n) * D2R;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, eps = (23.439 - 0.0000004 * n) * D2R;
  const sun = altAz(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / D2R, Math.asin(Math.sin(eps) * Math.sin(lam)) / D2R, jd, lat, lon);
  const d = jd - 2451543.5, N = (125.1228 - 0.0529538083 * d) * D2R, inc = 5.1454 * D2R, w = (318.0634 + 0.1643573223 * d) * D2R, a = 60.2666, e = 0.0549, M = norm360(115.3654 + 13.0649929509 * d) * D2R;
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M)); E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E), v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
  const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(inc)), yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(inc)), zh = r * Math.sin(v + w) * Math.sin(inc);
  const ye = yh * Math.cos(eps) - zh * Math.sin(eps), ze = yh * Math.sin(eps) + zh * Math.cos(eps);
  const moon = altAz(Math.atan2(ye, xh) / D2R, Math.atan2(ze, Math.hypot(xh, ye)) / D2R, jd, lat, lon);
  const elong = Math.atan2(yh, xh) - lam;
  return { sun, moon, moonLit: (1 - Math.cos(elong)) / 2 };
}
/** Unit vector the wind blows toward, from a meteorological "from" bearing. */
export function windVector(dirFromDeg: number): [number, number] { const a = (dirFromDeg + 180) * D2R; return [Math.sin(a), -Math.cos(a)]; }
