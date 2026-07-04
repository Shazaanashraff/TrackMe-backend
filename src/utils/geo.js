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

/**
 * Project a lat/lng point to local planar metres relative to an origin point,
 * using an equirectangular approximation (accurate enough at bus-route scale).
 */
function toLocalMeters(origin, point) {
  const latRad = toRad(origin.lat);
  const metersPerDegLat = 111_320;
  const metersPerDegLng = 111_320 * Math.cos(latRad);
  return {
    x: (point.lng - origin.lng) * metersPerDegLng,
    y: (point.lat - origin.lat) * metersPerDegLat
  };
}

/**
 * Shortest distance in metres from point `p` to the line segment `a`-`b`.
 * All inputs are { lat, lng }.
 */
function pointToSegmentMeters(p, a, b) {
  const origin = a;
  const P = toLocalMeters(origin, p);
  const A = { x: 0, y: 0 };
  const B = toLocalMeters(origin, b);

  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const lengthSq = abx * abx + aby * aby;

  let t = lengthSq === 0 ? 0 : ((P.x - A.x) * abx + (P.y - A.y) * aby) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const closest = { x: A.x + t * abx, y: A.y + t * aby };
  const dx = P.x - closest.x;
  const dy = P.y - closest.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Shortest distance in metres from `point` ({ lat, lng }) to a polyline
 * (array of { lat, lng }). Returns Infinity for a polyline with fewer than 2 points.
 */
function minDistanceToPolylineMeters(point, polylineCoords) {
  if (!Array.isArray(polylineCoords) || polylineCoords.length < 2) return Infinity;

  let min = Infinity;
  for (let i = 0; i < polylineCoords.length - 1; i += 1) {
    const d = pointToSegmentMeters(point, polylineCoords[i], polylineCoords[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Compare a driven breadcrumb against a saved route polyline.
 * `offThresholdMeters` classifies a breadcrumb point as "off route".
 * Returns { maxMeters, fractionOff, sampleCount }; all zero when there's
 * nothing usable to compare (degenerate breadcrumb or polyline).
 */
function deviationStats(breadcrumb, polylineCoords, offThresholdMeters = 150) {
  if (!Array.isArray(breadcrumb) || breadcrumb.length === 0 ||
      !Array.isArray(polylineCoords) || polylineCoords.length < 2) {
    return { maxMeters: 0, fractionOff: 0, sampleCount: 0 };
  }

  let maxMeters = 0;
  let offCount = 0;
  breadcrumb.forEach((point) => {
    const d = minDistanceToPolylineMeters(point, polylineCoords);
    if (d > maxMeters) maxMeters = d;
    if (d > offThresholdMeters) offCount += 1;
  });

  return {
    maxMeters,
    fractionOff: offCount / breadcrumb.length,
    sampleCount: breadcrumb.length
  };
}

module.exports = {
  haversineKm,
  nearestStop,
  segmentDistanceKm,
  pointToSegmentMeters,
  minDistanceToPolylineMeters,
  deviationStats
};
