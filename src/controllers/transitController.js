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

// --- Service classification ---------------------------------------------------
// Google's transit feed does NOT flag a line as express/long-distance, but the
// transit line's FULL name carries its two terminals (e.g. "Colombo-Kataragama").
// Local Colombo buses stay within the Western Province; intercity buses name a
// far-flung town. We classify off that far terminal so we can rank local stoppers
// first and push long-distance/express options to the bottom (with a label),
// instead of hiding them. See probe data: 98=Colombo-Akkaraipattu, 3=Colombo-
// Kataragama, 15-7=Colombo-Vavuniya — all intercity, none local stoppers.

// Major SL towns OUTSIDE Greater Colombo / the Western Province corridor. If a
// line's name mentions one of these, it's an intercity long-distance service.
// Inverted list (match distant towns, default to LOCAL) so we never wrongly
// demote a genuine local bus whose town we don't recognise.
const DISTANT_DESTINATIONS = [
  // Central
  'kandy', 'gampola', 'nawalapitiya', 'nuwara eliya', 'nuwaraeliya', 'hatton', 'talawakele',
  'lindula', 'maskeliya', 'bogawantalawa', 'dickoya', 'ginigathena', 'pussellawa', 'rikillagaskada',
  'walapane', 'kotmale', 'matale', 'dambulla', 'galewela', 'naula', 'ukuwela',
  // Uva
  'badulla', 'bandarawela', 'ella', 'haputale', 'welimada', 'passara', 'mahiyanganaya',
  'monaragala', 'wellawaya', 'bibile', 'buttala', 'siyambalanduwa', 'medagama',
  // Southern
  'galle', 'matara', 'tangalle', 'hambantota', 'tissamaharama', 'kataragama', 'beliatta',
  'deniyaya', 'akuressa', 'kamburupitiya', 'deiyandara', 'morawaka', 'urubokka', 'pitabeddara',
  'kotapola', 'weligama', 'ahangama', 'hikkaduwa', 'ambalangoda', 'elpitiya', 'pitigala',
  // Sabaragamuwa
  'ratnapura', 'balangoda', 'embilipitiya', 'pelmadulla', 'kahawatta', 'kegalle', 'mawanella',
  'rambukkana', 'warakapola', 'ruwanwella', 'yatiyantota', 'deraniyagala',
  // North-Western
  'kurunegala', 'kuliyapitiya', 'chilaw', 'puttalam', 'wariyapola', 'nikaweratiya', 'galgamuwa',
  'narammala', 'pannala', 'dankotuwa', 'wennappuwa', 'marawila',
  // North-Central
  'anuradhapura', 'polonnaruwa', 'kekirawa', 'kahatagasdigiliya', 'medawachchiya', 'mihintale',
  'kebithigollewa', 'hingurakgoda', 'kaduruwela', 'thambuttegama', 'galnewa',
  // Eastern
  'trincomalee', 'batticaloa', 'ampara', 'akkaraipattu', 'kalmunai', 'kantale', 'kattankudy',
  'eravur', 'valaichchenai', 'sammanthurai', 'pottuvil', 'dehiattakandiya',
  // Northern
  'jaffna', 'vavuniya', 'mannar', 'kilinochchi', 'mullaitivu', 'chavakachcheri', 'point pedro',
  'chunnakam', 'kodikamam', 'paranthan', 'medawachchiya',
  // Misc far hubs that show up in line names
  'sigiriya', 'udupussellawa', 'ragala',
  // Common romanisation variants Google sometimes returns (Th-/-aa-/etc.)
  'thangalle', 'thissamaharama', 'hambanthota', 'anuradhapuraya', 'kandagasdeniya',
  'nuwaraeliya', 'mathara', 'mathale', 'bandarawela', 'baduulla',
];

const CLASS_RANK = { LOCAL: 0, EXPRESS: 1, LONG_DISTANCE: 2 };
const worseClass = (a, b) => (CLASS_RANK[a] >= CLASS_RANK[b] ? a : b);   // most-intercity wins
const betterClass = (a, b) => (CLASS_RANK[a] <= CLASS_RANK[b] ? a : b);  // most-local wins

// Classify one bus line from its full name + stop spacing on the boarded leg.
function classifyLine(lineName, distanceMeters, stops) {
  const name = String(lineName || '').toLowerCase();
  // Word-boundary match so "Hanwella" doesn't match "ella" (Ella) etc. Multi-word
  // towns (e.g. "nuwara eliya") fall back to a substring check.
  const tokens = new Set(name.split(/[^a-z]+/).filter(Boolean));
  const isDistant = DISTANT_DESTINATIONS.some((t) => (t.includes(' ') ? name.includes(t) : tokens.has(t)));
  if (isDistant) return 'LONG_DISTANCE';
  if (tokens.has('express') || tokens.has('expressway') || tokens.has('highway')) return 'EXPRESS';
  // Fallback signal: a bus skipping local stops has a large gap between stops.
  const kmPerStop = (distanceMeters / 1000) / Math.max(stops, 1);
  if (kmPerStop >= 1.8) return 'EXPRESS';
  return 'LOCAL';
}

// Human-readable badge for a serviceClass (null = local, no badge needed).
const classLabel = (c) => (c === 'LONG_DISTANCE' ? 'Long distance' : c === 'EXPRESS' ? 'Express' : null);

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

    // For each bus-leg position, union the lines seen across all members. Sort the
    // interchangeable lines local-first, and let the leg's class be the BEST (most
    // local) option — if a rider can take a local bus on this leg, the leg is local.
    repBusLegs.forEach((leg, k) => {
      const lines = [];
      const classOf = new Map();
      let legClass = null;
      for (const m of members) {
        const ml = m.legs.filter((l) => l.type === 'BUS')[k];
        if (!ml?.line) continue;
        if (!lines.includes(ml.line)) lines.push(ml.line);
        if (!classOf.has(ml.line)) classOf.set(ml.line, ml.serviceClass);
        legClass = legClass ? betterClass(legClass, ml.serviceClass) : ml.serviceClass;
      }
      lines.sort((a, b) => CLASS_RANK[classOf.get(a)] - CLASS_RANK[classOf.get(b)]);
      leg.lines = lines;                                   // interchangeable options, local-first
      leg.lineClasses = lines.map((l) => classOf.get(l));  // parallel class per line
      leg.line = lines[0];                                 // primary (most local)
      leg.serviceClass = legClass || leg.serviceClass;
    });
    rep.buses = repBusLegs.map((l) => l.line);
    // Recompute option class from the (now best-per-leg) leg classes.
    rep.serviceClass = repBusLegs.reduce((acc, l) => worseClass(acc, l.serviceClass), 'LOCAL');
    rep.serviceLabel = classLabel(rep.serviceClass);
    out.push(rep);
  }
  // Local stoppers first, then express, then long-distance; faster first within a class.
  return out.sort((a, b) => CLASS_RANK[a.serviceClass] - CLASS_RANK[b.serviceClass] || a.durationSec - b.durationSec);
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
        const lineName = td.transitLine?.name || '';
        const stops = td.stopCount || 0;
        const distanceMeters = st.distanceMeters || 0;
        const serviceClass = classifyLine(lineName, distanceMeters, stops);
        const bus = {
          type: 'BUS',
          line: td.transitLine?.nameShort || td.transitLine?.name || '?',
          lineName,
          vehicle: td.transitLine?.vehicle?.type || 'BUS',
          board: td.stopDetails?.departureStop?.name || '',
          alight: td.stopDetails?.arrivalStop?.name || '',
          stops,
          distanceMeters,
          serviceClass,                 // LOCAL | EXPRESS | LONG_DISTANCE
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

  // Option-level class = the worst (most-intercity) class among its bus legs:
  // a trip is only as "local" as its least-local mandatory bus.
  const busLegs = legs.filter((l) => l.type === 'BUS');
  const serviceClass = busLegs.reduce((acc, l) => worseClass(acc, l.serviceClass), 'LOCAL');

  return {
    durationSec: secs(r.duration),
    walkMeters,
    departureTime,
    arrivalTime,
    buses,                 // ['143'] or ['166','152'] for transfers
    transfers: Math.max(0, buses.length - 1),
    serviceClass,                       // LOCAL | EXPRESS | LONG_DISTANCE
    serviceLabel: classLabel(serviceClass),
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
    // Group interchangeable buses, drop options another option strictly beats, then
    // order local stoppers first and push express/long-distance to the bottom.
    const data = pruneRedundant(groupRoutes(raw))
      .sort((a, b) => CLASS_RANK[a.serviceClass] - CLASS_RANK[b.serviceClass] || a.durationSec - b.durationSec);

    res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[transit] error:', err.message);
    res.status(500).json({ success: false, message: 'Transit planning error.' });
  }
};

exports._normalizeRoute = normalizeRoute;
exports._groupRoutes = groupRoutes;
exports._pruneRedundant = pruneRedundant;
