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
 * using an equirectangular approximation (accurate enough at vehicle-route scale).
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
 * Total length in metres of a polyline (array of { lat, lng }).
 */
function polylineLengthMeters(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < coords.length - 1; i += 1) {
    total += haversineKm(coords[i].lat, coords[i].lng, coords[i + 1].lat, coords[i + 1].lng) * 1000;
  }
  return total;
}

/**
 * Re-sample a polyline so consecutive points are `stepMeters` apart along the
 * line (the last point is always kept). Returns [] for fewer than 2 points.
 */
function resamplePolyline(coords, stepMeters = 10) {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const out = [{ lat: coords[0].lat, lng: coords[0].lng }];
  let carry = 0; // metres travelled since the last emitted point
  for (let i = 0; i < coords.length - 1; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
    if (segLen === 0) continue;
    let pos = stepMeters - carry; // distance into this segment of the next point
    while (pos <= segLen) {
      const t = pos / segLen;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      pos += stepMeters;
    }
    carry = segLen - (pos - stepMeters);
  }
  const last = coords[coords.length - 1];
  const tail = out[out.length - 1];
  if (tail.lat !== last.lat || tail.lng !== last.lng) out.push({ lat: last.lat, lng: last.lng });
  return out;
}

/**
 * Fraction (0..1) of `from`'s points that lie within `radiusMeters` of the
 * polyline `to`. Both are arrays of { lat, lng }; `from` should be resampled.
 */
function coverageFraction(from, to, radiusMeters = 25) {
  if (!Array.isArray(from) || from.length === 0) return 0;
  let near = 0;
  from.forEach((point) => {
    if (minDistanceToPolylineMeters(point, to) <= radiusMeters) near += 1;
  });
  return near / from.length;
}

/**
 * Project `point` onto the polyline. Returns { point, distanceMeters (to the
 * line), alongMeters (distance from the polyline's start to the projection) }
 * or null for a polyline with fewer than 2 points.
 */
function projectOntoPolyline(point, coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  let best = null;
  let walked = 0;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
    const A = { x: 0, y: 0 };
    const B = toLocalMeters(a, b);
    const P = toLocalMeters(a, point);
    const lenSq = B.x * B.x + B.y * B.y;
    let t = lenSq === 0 ? 0 : (P.x * B.x + P.y * B.y) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const dx = P.x - (A.x + t * B.x);
    const dy = P.y - (A.y + t * B.y);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!best || dist < best.distanceMeters) {
      best = {
        point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
        distanceMeters: dist,
        alongMeters: walked + segLen * t
      };
    }
    walked += segLen;
  }
  return best;
}

module.exports = {
  haversineKm,
  nearestStop,
  segmentDistanceKm,
  pointToSegmentMeters,
  minDistanceToPolylineMeters,
  polylineLengthMeters,
  resamplePolyline,
  coverageFraction,
  projectOntoPolyline
};
