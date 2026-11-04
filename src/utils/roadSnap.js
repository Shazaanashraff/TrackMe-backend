// Polyline encode/decode helpers for driver-recorded custom routes. Road fitting
// itself lives in utils/mapMatch (OpenStreetMap map matching, no Google API).

const { haversineKm } = require('./geo');
const { _decodePolyline: decodePolyline } = require('../controllers/routeGeometryController');

// Standard Google encoded-polyline encoder (inverse of the decoder in
// routeGeometryController.js). Points are [{lat,lng}, ...].
function encodePolyline(points) {
  let lastLat = 0;
  let lastLng = 0;
  let output = '';

  const encodeValue = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let result = '';
    while (v >= 0x20) {
      result += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    result += String.fromCharCode(v + 63);
    return result;
  };

  for (const point of points) {
    const lat = Math.round(point.lat * 1e5);
    const lng = Math.round(point.lng * 1e5);
    output += encodeValue(lat - lastLat);
    output += encodeValue(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return output;
}

// Drop GPS jitter: keep the first point, then only keep a later point once it's
// at least `minMeters` from the last kept point. Always keeps the last point.
function downsample(points, minMeters = 8) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const kept = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = kept[kept.length - 1];
    const cur = points[i];
    const meters = haversineKm(prev.lat, prev.lng, cur.lat, cur.lng) * 1000;
    if (meters >= minMeters) kept.push(cur);
  }
  const last = points[points.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

module.exports = { encodePolyline, decodePolyline, downsample };
