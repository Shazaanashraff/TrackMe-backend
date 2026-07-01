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

// Normalise a line/route number for comparison: "143 / 4" -> "143/4", upper-case.
const normLine = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
// Base number (drop #-disambiguator and any sub-route suffix): "138#2" -> "138".
const baseNum = (s) => normLine(s).split('#')[0];

// Ask Google TRANSIT for the buses that serve origin->destination, and return each
// bus leg's { line, polyline }. This is the REAL bus geometry (not driving directions
// between town centres), so a route drawn from it follows the actual service.
async function transitBusLegs(from, to, key) {
  const bodyFor = (extra) => ({
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode: 'TRANSIT',
    computeAlternativeRoutes: true,
    transitPreferences: { allowedTravelModes: ['BUS'], ...extra },
  });
  // Two routing variants (default + LESS_WALKING) surface far more distinct bus
  // lines than a single call — critical for matching a specific route number.
  const variants = [bodyFor({}), bodyFor({ routingPreference: 'LESS_WALKING' })];

  const fetchVariant = async (body) => {
    try {
      const gRes = await fetch(ROUTES_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask':
            'routes.legs.steps.transitDetails.transitLine.nameShort,routes.legs.steps.transitDetails.transitLine.name,routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.travelMode',
        },
        body: JSON.stringify(body),
      });
      if (!gRes.ok) {
        console.error(`[route-path] transit ${gRes.status}: ${(await gRes.text()).slice(0, 200)}`);
        return [];
      }
      return (await gRes.json()).routes || [];
    } catch (err) {
      console.error('[route-path] transit variant error:', err.message);
      return [];
    }
  };

  const results = await Promise.all(variants.map(fetchVariant));
  const legs = [];
  for (const routes of results) {
    for (const r of routes) {
      for (const leg of r.legs || []) {
        for (const st of leg.steps || []) {
          if (st.transitDetails && st.polyline?.encodedPolyline) {
            const td = st.transitDetails;
            legs.push({
              line: td.transitLine?.nameShort || td.transitLine?.name || '',
              polyline: st.polyline.encodedPolyline,
            });
          }
        }
      }
    }
  }
  return legs;
}

// GET /api/bus/routes/:routeId/path  -> { success, data: { coords: [{lat,lng}], cached, matched } }
// Accurate route geometry: the real polyline of the matching bus line from Google
// Transit (origin -> destination). No match => no line (we do not invent geometry).
exports.getRoutePath = async (req, res) => {
  const routeId = String(req.params.routeId);

  if (pathCache.has(routeId)) {
    const c = pathCache.get(routeId);
    return res.status(200).json({ success: true, data: { coords: c.coords, coordsReturn: c.coordsReturn || [], cached: true } });
  }

  const key = process.env.GOOGLE_ROUTES_KEY || process.env.GOOGLE_PLACES_KEY;
  if (!key) {
    return res.status(503).json({ success: false, message: 'Routing not configured (missing GOOGLE_PLACES_KEY).' });
  }

  try {
    const route = await Route.findOne({ routeId, isDeleted: false }).select('stops routeId pathPolyline pathPolylineReturn');
    if (!route) return res.status(404).json({ success: false, message: 'Route not found.' });

    // Prefer pre-computed accurate geometry (backfilled from a matched transit line).
    // Instant, stable, and no live API call. coordsReturn is the return-direction path
    // (empty when it's the same road back).
    if (route.pathPolyline) {
      const coords = decodePolyline(route.pathPolyline);
      const coordsReturn = route.pathPolylineReturn ? decodePolyline(route.pathPolylineReturn) : [];
      pathCache.set(routeId, { coords, coordsReturn, at: Date.now() });
      return res.status(200).json({ success: true, data: { coords, coordsReturn, cached: true, matched: true, source: 'stored' } });
    }

    const stops = orderedStops(route);
    if (stops.length < 2) {
      return res.status(200).json({ success: true, data: { coords: [], cached: false, matched: false } });
    }

    const from = stops[0];
    const to = stops[stops.length - 1];
    const want = baseNum(routeId);

    const legs = await transitBusLegs(from, to, key);
    // Prefer an exact line match; fall back to a base-number match (ignoring suffixes).
    let hit = legs.find((l) => normLine(l.line) === normLine(routeId));
    if (!hit) hit = legs.find((l) => baseNum(l.line) === want);

    if (!hit) {
      // No transit line matched. We do NOT invent geometry (geocoded stop names are
      // unreliable and can detour), so draw nothing — only real matched lines show.
      return res.status(200).json({ success: true, data: { coords: [], cached: false, matched: false } });
    }

    const coords = decodePolyline(hit.polyline);
    pathCache.set(routeId, { coords, at: Date.now() });
    // Persist so this route never needs another Routes API call (lazy backfill):
    // the first view fills it, every later view serves from the stored polyline.
    route.pathPolyline = hit.polyline;
    route.save().catch((e) => console.warn('[route-path] persist failed:', e.message));
    res.status(200).json({ success: true, data: { coords, cached: false, matched: true, line: hit.line } });
  } catch (err) {
    console.error('[route-path] error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to compute route path.' });
  }
};

// Exported for unit testing.
exports._decodePolyline = decodePolyline;
exports._pathCache = pathCache;
