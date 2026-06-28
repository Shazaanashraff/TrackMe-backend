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

// Structure signature: the sequence of board->alight stops across the bus legs,
// ignoring which line serves each leg. Itineraries with the same signature are
// the "same trip" with interchangeable buses (e.g. take 3 OR 98 on that leg).
function structureSig(r) {
  return r.legs.filter((l) => l.type === 'BUS').map((l) => `${l.board}→${l.alight}`).join(' | ');
}

// Group itineraries from the Google variants like the Maps app does: collapse
// trips that share the same board->alight structure into ONE option, and on each
// bus leg list every interchangeable line we saw. Keeps the fastest member's
// timing/geometry. Sorted fastest-first.
function groupRoutes(routes) {
  const groups = new Map();
  for (const r of routes) {
    if (r.buses.length === 0) continue;
    const sig = structureSig(r);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(r);
  }

  const out = [];
  for (const members of groups.values()) {
    members.sort((a, b) => a.durationSec - b.durationSec || a.walkMeters - b.walkMeters);
    const rep = members[0];
    const repBusLegs = rep.legs.filter((l) => l.type === 'BUS');

    // For each bus-leg position, union the lines seen across all members.
    repBusLegs.forEach((leg, k) => {
      const lines = [];
      for (const m of members) {
        const ln = m.legs.filter((l) => l.type === 'BUS')[k]?.line;
        if (ln && !lines.includes(ln)) lines.push(ln);
      }
      leg.lines = lines;     // interchangeable options for this leg
      leg.line = lines[0];   // primary
    });
    rep.buses = repBusLegs.map((l) => l.line);
    out.push(rep);
  }
  return out.sort((a, b) => a.durationSec - b.durationSec);
}

// The lines a rider could board FIRST on this option (the first bus leg).
function leadLines(r) {
  const firstBus = r.legs.find((l) => l.type === 'BUS');
  return firstBus ? (firstBus.lines && firstBus.lines.length ? firstBus.lines : [firstBus.line]) : [];
}

// Prune only *redundant* options: an option is dropped only when it is both
//   (a) worse-or-equal on time AND walk AND transfers than a kept option, and
//   (b) every bus it starts with is already offered by a kept option.
// This kills the "same bus shown again as a slower transfer" noise (the 98/3
// case) while KEEPING genuinely different routes even if they're a bit worse
// (so a corridor still shows several real choices). Fastest-first.
function pruneRedundant(routes) {
  const dominates = (a, b) =>
    a.durationSec <= b.durationSec &&
    a.walkMeters <= b.walkMeters &&
    a.transfers <= b.transfers &&
    (a.durationSec < b.durationSec || a.walkMeters < b.walkMeters || a.transfers < b.transfers);

  const sorted = [...routes].sort((a, b) => a.durationSec - b.durationSec);
  const kept = [];
  for (const r of sorted) {
    const lead = leadLines(r);
    const worse = kept.some((k) => dominates(k, r));
    const allLeadCovered = lead.length > 0 && lead.every((l) => kept.some((k) => leadLines(k).includes(l)));
    if (worse && allLeadCovered) continue; // redundant: worse AND no new boarding option
    kept.push(r);
  }
  return kept;
}

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

  // Build one request body per routing variant. The default returns Google's
  // fastest options (often direct + a long walk); LESS_WALKING surfaces practical
  // transfer (indirect) itineraries that trade a change of bus for far less
  // walking. We run both and merge so the rider sees direct AND indirect options.
  const bodyFor = (extra) => ({
    origin: { location: { latLng: { latitude: fromLat, longitude: fromLng } } },
    destination: { location: { latLng: { latitude: toLat, longitude: toLng } } },
    travelMode: 'TRANSIT',
    computeAlternativeRoutes: true,
    transitPreferences: { allowedTravelModes: ['BUS'], ...extra },
  });
  const variants = [bodyFor({}), bodyFor({ routingPreference: 'LESS_WALKING' })];

  const fetchVariant = async (body) => {
    try {
      const gRes = await fetch(ROUTES_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
        body: JSON.stringify(body),
      });
      if (!gRes.ok) {
        const detail = await gRes.text();
        console.error(`[transit] Routes API ${gRes.status}: ${detail.slice(0, 300)}`);
        return null;
      }
      const json = await gRes.json();
      return json.routes || [];
    } catch (err) {
      console.error('[transit] variant error:', err.message);
      return null;
    }
  };

  try {
    const results = await Promise.all(variants.map(fetchVariant));
    // If every upstream call failed, surface a 502; otherwise use whatever returned.
    if (results.every((r) => r === null)) {
      return res.status(502).json({ success: false, message: 'Transit planning failed upstream.' });
    }

    const raw = results.flatMap((r) => r || []).map(normalizeRoute).filter((r) => r.buses.length > 0);
    // Group interchangeable buses, then drop options another option strictly beats.
    const data = pruneRedundant(groupRoutes(raw));

    res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[transit] error:', err.message);
    res.status(500).json({ success: false, message: 'Transit planning error.' });
  }
};

exports._normalizeRoute = normalizeRoute;
exports._groupRoutes = groupRoutes;
exports._pruneRedundant = pruneRedundant;
