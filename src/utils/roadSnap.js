// Snap-to-roads + polyline encode/decode for driver-recorded custom routes.
// Mirrors the "never invent geometry" pattern from routeGeometryController.js:
// on any snap failure (missing key, quota, API error) we fall back to encoding
// the raw (downsampled) breadcrumb instead of inventing a road-following line.

const { haversineKm } = require('./geo');
const { _decodePolyline: decodePolyline } = require('../controllers/routeGeometryController');

const ROADS_API = 'https://roads.googleapis.com/v1/snapToRoads';
const MAX_POINTS_PER_BATCH = 100;

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

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function snapBatch(points, key) {
  const path = points.map((p) => `${p.lat},${p.lng}`).join('|');
  const url = `${ROADS_API}?interpolate=true&key=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Roads API ${res.status}`);
  const body = await res.json();
  return (body.snappedPoints || []).map((sp) => ({
    lat: sp.location.latitude,
    lng: sp.location.longitude
  }));
}

// Snap a breadcrumb to roads via the Google Roads API, batching in chunks of
// <=100 points (API limit) and stitching the results. Falls back to encoding
// the raw points (snapped:false) on any error or missing key/quota.
async function snapToRoads(points) {
  const key = process.env.GOOGLE_ROADS_KEY || process.env.GOOGLE_ROUTES_KEY || process.env.GOOGLE_PLACES_KEY;
  const fallback = () => ({ polyline: encodePolyline(points), snapped: false });

  if (!key || !Array.isArray(points) || points.length < 2) return fallback();

  try {
    const batches = chunk(points, MAX_POINTS_PER_BATCH);
    const snappedBatches = await Promise.all(batches.map((batch) => snapBatch(batch, key)));
    const snappedPoints = snappedBatches.flat();
    if (snappedPoints.length === 0) return fallback();
    return { polyline: encodePolyline(snappedPoints), snapped: true };
  } catch (err) {
    console.warn('[roadSnap] snapToRoads failed, falling back to raw breadcrumb:', err.message);
    return fallback();
  }
}

module.exports = { encodePolyline, decodePolyline, downsample, snapToRoads };
