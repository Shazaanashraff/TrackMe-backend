// Geo helpers for journey planning.
// Pure functions (no DB / no I/O) so they are cheap to unit-test.

const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two lat/lng points, in kilometres.
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Find the stop in `stops` closest to (lat, lng).
 * Returns { index, stop, distanceKm } or null when there are no usable stops.
 */
function nearestStop(stops, lat, lng) {
  if (!Array.isArray(stops) || stops.length === 0) return null;

  let best = null;
  stops.forEach((stop, index) => {
    if (typeof stop?.lat !== 'number' || typeof stop?.lng !== 'number') return;
    const distanceKm = haversineKm(lat, lng, stop.lat, stop.lng);
    if (!best || distanceKm < best.distanceKm) {
      best = { index, stop, distanceKm };
    }
  });
  return best;
}

/**
 * Sum the great-circle distance walked along an ordered stop list between
 * indices `from` and `to` (inclusive of the segment endpoints).
 */
function segmentDistanceKm(stops, from, to) {
  let total = 0;
  for (let i = from; i < to; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a && b) total += haversineKm(a.lat, a.lng, b.lat, b.lng);
  }
  return total;
}

module.exports = { haversineKm, nearestStop, segmentDistanceKm };
