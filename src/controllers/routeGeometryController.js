// Road-following geometry for a route, computed once via the Google Routes API
// and cached in memory. Route stops are static, so each route is computed at most
// once per server lifetime (~25 routes total) — effectively free.
//
// SECURITY: uses the server-side GOOGLE_PLACES_KEY (never sent to the client).
// Requires the Routes API to be enabled on the Google project.

const Route = require('../models/Route');

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// routeId -> { coords: [{lat,lng}], at: epochMs }
const pathCache = new Map();

// Standard Google encoded-polyline decoder.
function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return coords;
}

function orderedStops(route) {
  return (route.stops || [])
    .filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

const toWaypoint = (s) => ({ location: { latLng: { latitude: s.lat, longitude: s.lng } } });

// GET /api/bus/routes/:routeId/path  -> { success, data: { coords: [{lat,lng}], cached } }
exports.getRoutePath = async (req, res) => {
  const routeId = String(req.params.routeId);

  if (pathCache.has(routeId)) {
    return res.status(200).json({ success: true, data: { coords: pathCache.get(routeId).coords, cached: true } });
  }

  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) {
    return res.status(503).json({ success: false, message: 'Routing not configured (missing GOOGLE_PLACES_KEY).' });
  }

  try {
    const route = await Route.findOne({ routeId, isDeleted: false }).select('stops');
    if (!route) return res.status(404).json({ success: false, message: 'Route not found.' });

    const stops = orderedStops(route);
    if (stops.length < 2) {
      return res.status(200).json({ success: true, data: { coords: stops.map((s) => ({ lat: s.lat, lng: s.lng })), cached: false } });
    }

    const body = {
      origin: toWaypoint(stops[0]),
      destination: toWaypoint(stops[stops.length - 1]),
      intermediates: stops.slice(1, -1).map(toWaypoint),
      travelMode: 'DRIVE',
      polylineQuality: 'HIGH_QUALITY',
    };

    const gRes = await fetch(ROUTES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.polyline.encodedPolyline',
      },
      body: JSON.stringify(body),
    });

    if (!gRes.ok) {
      const detail = await gRes.text();
      console.error(`[route-path] Routes API ${gRes.status}: ${detail.slice(0, 300)}`);
      // Graceful fallback: straight stop-to-stop line so the map still draws something.
      const coords = stops.map((s) => ({ lat: s.lat, lng: s.lng }));
      return res.status(200).json({ success: true, data: { coords, cached: false, fallback: true } });
    }

    const json = await gRes.json();
    const encoded = json.routes?.[0]?.polyline?.encodedPolyline;
    const coords = encoded ? decodePolyline(encoded) : stops.map((s) => ({ lat: s.lat, lng: s.lng }));

    pathCache.set(routeId, { coords, at: Date.now() });
    res.status(200).json({ success: true, data: { coords, cached: false } });
  } catch (err) {
    console.error('[route-path] error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to compute route path.' });
  }
};

// Exported for unit testing.
exports._decodePolyline = decodePolyline;
exports._pathCache = pathCache;
