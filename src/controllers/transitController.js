// Real public-transit journey planning via the Google Routes API (TRANSIT mode,
// buses only). Replaces the old own-data matcher: Google has accurate Colombo bus
// routes, real stops, and practical walking legs.
//
// SECURITY: uses the server-side GOOGLE_PLACES_KEY (never sent to the client).
// Requires the Routes API enabled on the Google project.

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const FIELD_MASK = [
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.polyline.encodedPolyline',
  'routes.legs.steps.transitDetails.transitLine.nameShort',
  'routes.legs.steps.transitDetails.transitLine.name',
  'routes.legs.steps.transitDetails.transitLine.vehicle.type',
  'routes.legs.steps.transitDetails.stopDetails.departureStop.name',
  'routes.legs.steps.transitDetails.stopDetails.arrivalStop.name',
  'routes.legs.steps.transitDetails.stopCount',
  'routes.legs.steps.transitDetails.headsign',
  'routes.legs.steps.transitDetails.headway',
  'routes.legs.steps.transitDetails.localizedValues',
].join(',');

const secs = (v) => (typeof v === 'string' ? Number(v.replace('s', '')) || 0 : 0);

function normalizeRoute(r) {
  const legs = [];
  let walkMeters = 0;
  const buses = [];
  let departureTime = null;
  let arrivalTime = null;

  for (const leg of r.legs || []) {
    for (const st of leg.steps || []) {
      const polyline = st.polyline?.encodedPolyline || null;
      if (st.travelMode === 'WALK') {
        const m = st.distanceMeters || 0;
        walkMeters += m;
        legs.push({ type: 'WALK', meters: m, durationSec: secs(st.staticDuration), polyline });
      } else if (st.transitDetails) {
        const td = st.transitDetails;
        const lv = td.localizedValues || {};
        const dep = lv.departureTime?.time?.text || null;
        const arr = lv.arrivalTime?.time?.text || null;
        if (!departureTime) departureTime = dep;
        arrivalTime = arr || arrivalTime;
        const bus = {
          type: 'BUS',
          line: td.transitLine?.nameShort || td.transitLine?.name || '?',
          lineName: td.transitLine?.name || '',
          vehicle: td.transitLine?.vehicle?.type || 'BUS',
          board: td.stopDetails?.departureStop?.name || '',
          alight: td.stopDetails?.arrivalStop?.name || '',
          stops: td.stopCount || 0,
          headsign: td.headsign || '',
          headwaySec: secs(td.headway),
          durationSec: secs(st.staticDuration),
          departureTime: dep,
          arrivalTime: arr,
          polyline,
        };
        legs.push(bus);
        buses.push(bus.line);
      }
    }
  }

  return {
    durationSec: secs(r.duration),
    walkMeters,
    departureTime,
    arrivalTime,
    buses,                 // ['143'] or ['166','152'] for transfers
    transfers: Math.max(0, buses.length - 1),
    polyline: r.polyline?.encodedPolyline || null,
    legs,
  };
}

// GET /api/transit/plan?fromLat&fromLng&toLat&toLng
exports.planTransit = async (req, res) => {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return res.status(503).json({ success: false, message: 'Transit planning not configured (missing GOOGLE_PLACES_KEY).' });

  const fromLat = Number(req.query.fromLat), fromLng = Number(req.query.fromLng);
  const toLat = Number(req.query.toLat), toLng = Number(req.query.toLng);
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) {
    return res.status(400).json({ success: false, message: 'fromLat, fromLng, toLat and toLng are required numeric query params.' });
  }

  try {
    const gRes = await fetch(ROUTES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: fromLat, longitude: fromLng } } },
        destination: { location: { latLng: { latitude: toLat, longitude: toLng } } },
        travelMode: 'TRANSIT',
        computeAlternativeRoutes: true,
        transitPreferences: { allowedTravelModes: ['BUS'] },
      }),
    });

    if (!gRes.ok) {
      const detail = await gRes.text();
      console.error(`[transit] Routes API ${gRes.status}: ${detail.slice(0, 300)}`);
      return res.status(502).json({ success: false, message: 'Transit planning failed upstream.' });
    }

    const json = await gRes.json();
    const data = (json.routes || [])
      .map(normalizeRoute)
      .filter((r) => r.buses.length > 0)
      .sort((a, b) => a.durationSec - b.durationSec);

    res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[transit] error:', err.message);
    res.status(500).json({ success: false, message: 'Transit planning error.' });
  }
};

exports._normalizeRoute = normalizeRoute;
