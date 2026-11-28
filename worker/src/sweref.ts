// EPSG:3006 (SWEREF99 TM) framåt-transform utan proj4 — samma serie som proj4 tmerc.
const A = 6378137.0;
const F = 1 / 298.257222101; // GRS80
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const LON0 = 15 * (Math.PI / 180);
const X0 = 500000;

export function toSWEREF(lonDeg: number, latDeg: number): [number, number] {
  const lat = latDeg * (Math.PI / 180);
  const lon = lonDeg * (Math.PI / 180);
  const sin = Math.sin(lat), cos = Math.cos(lat), tan = Math.tan(lat);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan;
  const C = EP2 * cos * cos;
  const A_ = cos * (lon - LON0);
  const M =
    A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256) * lat -
      (3 * E2 / 8 + (3 * E2 * E2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * lat) +
      ((15 * E2 * E2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * lat) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * lat));
  const e =
    K0 * N * (A_ + ((1 - T + C) * A_ ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * A_ ** 5) / 120) + X0;
  const n =
    K0 *
    (M +
      N * tan * (A_ ** 2 / 2 + ((5 - T + 9 * C + 4 * C * C) * A_ ** 4) / 24 +
        ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * A_ ** 6) / 720));
  return [e, n];
}
