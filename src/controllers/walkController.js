// Real walking path between two points, via the Google Routes API (WALK mode).
// Used by the live map to draw an accurate "walk to your stop" line that follows
// footpaths/roads instead of a straight line through buildings.
//
// SECURITY: uses the server-side Routes key (never sent to the client). The client
// calls this ONCE when the user confirms their location — never on every pin drag —
// to keep paid API usage minimal.

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = 'routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration';

const secs = (v) => (typeof v === 'string' ? Number(v.replace('s', '')) || 0 : 0);

// @desc  Walking polyline from (fromLat,fromLng) to (toLat,toLng)
// @route GET /api/bus/walk
exports.getWalkPath = async (req, res) => {
  const key = process.env.GOOGLE_ROUTES_KEY || process.env.GOOGLE_PLACES_KEY;
  if (!key) {
    return res.status(503).json({ success: false, message: 'Walking directions not configured.' });
  }

  const fromLat = Number(req.query.fromLat);
  const fromLng = Number(req.query.fromLng);
  const toLat = Number(req.query.toLat);
  const toLng = Number(req.query.toLng);
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) {
    return res.status(400).json({ success: false, message: 'fromLat, fromLng, toLat and toLng are required numeric query params.' });
  }

  const body = {
    origin: { location: { latLng: { latitude: fromLat, longitude: fromLng } } },
    destination: { location: { latLng: { latitude: toLat, longitude: toLng } } },
    travelMode: 'WALK',
    polylineQuality: 'HIGH_QUALITY',
  };

  try {
    const gRes = await fetch(ROUTES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify(body),
    });
    if (!gRes.ok) {
      const detail = await gRes.text();
      console.error(`[walk] Routes API ${gRes.status}: ${detail.slice(0, 300)}`);
      return res.status(502).json({ success: false, message: 'Walking directions failed upstream.' });
    }
    const json = await gRes.json();
    const route = (json.routes || [])[0];
    if (!route?.polyline?.encodedPolyline) {
      return res.status(200).json({ success: true, encodedPolyline: '', distanceMeters: 0, durationSec: 0 });
    }
    return res.status(200).json({
      success: true,
      encodedPolyline: route.polyline.encodedPolyline,
      distanceMeters: route.distanceMeters || 0,
      durationSec: secs(route.duration),
    });
  } catch (err) {
    console.error('[walk] error:', err.message);
    return res.status(500).json({ success: false, message: 'Walking directions error.' });
  }
};
