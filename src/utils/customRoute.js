// Shared logic for driver-recorded custom routes: creating the provisional route,
// validating and map-matching a recording ride, and building the route once enough
// rides are in. Controllers stay thin; the pure maths lives in routeConsensus.js
// and mapMatch/.

const crypto = require('crypto');
const Route = require('../models/Route');
const RouteRecordingRun = require('../models/RouteRecordingRun');
const Vehicle = require('../models/Vehicle');
const RiderProfile = require('../models/RiderProfile');
const DriverEnrollment = require('../models/DriverEnrollment');
const { haversineKm, polylineLengthMeters } = require('./geo');
const { encodePolyline, decodePolyline } = require('./roadSnap');
const { matchRawTrace, MatchUnavailable } = require('./mapMatch');
const { buildConsensus } = require('./routeConsensus');
const { _pathCache } = require('../controllers/routeGeometryController');
const stopArrivals = require('../services/stopArrivalNotifier');

const intEnv = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const requiredRuns = () => intEnv('CUSTOM_ROUTE_REQUIRED_RUNS', 5);
const minPoints = () => intEnv('CUSTOM_ROUTE_MIN_POINTS', 20);
const minMeters = () => intEnv('CUSTOM_ROUTE_MIN_METERS', 500);

// A later ride must start and end within this distance of the first accepted ride.
const SAME_ROUTE_TOLERANCE_M = 500;
const MAX_STOPS_PER_RUN = 100;

const PLACEHOLDER = 'Recording…';
const meters = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;

const routeIdPrefix = (managerId) =>
  crypto.createHash('sha1').update(String(managerId)).digest('hex').slice(0, 4).toUpperCase();

// Not a count: two vehicles created at once must not collide. Random suffix, and
// the caller retries on a duplicate-key error.
const generateCustomRouteId = (managerId) =>
  `CUST-${routeIdPrefix(managerId)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/**
 * Create the provisional route a custom-route vehicle runs on while it is being
 * recorded. Satisfies the Route required fields with placeholders that are replaced
 * when the manager confirms. Retries on a routeId collision.
 */
async function createProvisionalRoute({ managerId, serviceType = 'PUBLIC' }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await Route.create({
        routeId: generateCustomRouteId(managerId),
        routeName: PLACEHOLDER,
        source: PLACEHOLDER,
        destination: PLACEHOLDER,
        distance: 0,
        fare: 0,
        serviceType,
        origin: 'RECORDED',
        status: 'RECORDING',
        managerId,
        createdBy: managerId,
        recording: { requiredRuns: requiredRuns(), acceptedRuns: 0 }
      });
    } catch (error) {
      if (error?.code !== 11000 || attempt === 4) throw error;
    }
  }
  return null; // unreachable
}

const lengthMeters = (points) => polylineLengthMeters(points.map((p) => ({ lat: p.lat, lng: p.lng })));

/**
 * Normalise and bound a driver's upload before it touches the database.
 * Returns { points, stops } with only finite numbers and capped sizes.
 */
function sanitizeRunInput(body) {
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const validLatLng = (p) => p && Math.abs(num(p.lat)) <= 90 && Math.abs(num(p.lng)) <= 180
    && num(p.lat) !== null && num(p.lng) !== null;

  const points = (Array.isArray(body.points) ? body.points : [])
    .filter(validLatLng)
    .slice(0, RouteRecordingRun.MAX_POINTS)
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), t: num(p.t), acc: num(p.acc) }));

  const stops = (Array.isArray(body.stops) ? body.stops : [])
    .filter(validLatLng)
    .slice(0, MAX_STOPS_PER_RUN)
    .map((s) => ({
      lat: Number(s.lat),
      lng: Number(s.lng),
      t: num(s.t),
      name: String(s.name || '').trim().slice(0, 80)
    }));

  return { points, stops };
}

// Fingerprint of a whole track, so only a genuinely identical upload counts as a duplicate
// (two rides can share a start, an end and a length and still be different journeys).
const signature = (points) =>
  crypto.createHash('sha1')
    .update(points.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(';'))
    .digest('hex');

/**
 * Decide whether a ride may count, before any matching work is spent on it.
 * Returns '' when it is fine, otherwise a rejectReason.
 */
async function checkRunQuality(routeId, points) {
  if (points.length < minPoints()) return 'TOO_FEW_POINTS';
  if (lengthMeters(points) < minMeters()) return 'TOO_SHORT';

  const accepted = await RouteRecordingRun.find({ routeId, status: { $in: ['ACCEPTED', 'PENDING_MATCH'] } })
    .select('points.lat points.lng runNumber createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const sig = signature(points);
  if (accepted.some((r) => r.points?.length && signature(r.points) === sig)) return 'DUPLICATE';

  const reference = accepted.find((r) => r.points?.length);
  if (reference) {
    const rs = reference.points[0];
    const re = reference.points[reference.points.length - 1];
    const startsOk = meters(points[0], rs) <= SAME_ROUTE_TOLERANCE_M;
    const endsOk = meters(points[points.length - 1], re) <= SAME_ROUTE_TOLERANCE_M;
    if (!startsOk || !endsOk) return 'NOT_SAME_ROUTE';
  }
  return '';
}

/**
 * Map-match one stored run. On success the run becomes ACCEPTED and gets its number;
 * when the matcher is unreachable it stays PENDING_MATCH (retried later); when the
 * trace is not on any road it is REJECTED.
 * Returns the updated run document.
 */
async function matchAndAcceptRun(run) {
  let result;
  try {
    result = await matchRawTrace(run.points.map((p) => ({ lat: p.lat, lng: p.lng, t: p.t, acc: p.acc })));
  } catch (error) {
    if (error instanceof MatchUnavailable) return run; // stays PENDING_MATCH
    throw error;
  }

  if (!result.coords || result.coords.length < 2) {
    run.status = 'REJECTED';
    run.rejectReason = 'NOT_ON_ROAD';
    await run.save();
    return run;
  }

  const acceptedCount = await RouteRecordingRun.countDocuments({ routeId: run.routeId, status: 'ACCEPTED' });
  run.matched = {
    polyline: encodePolyline(result.coords),
    confidence: result.confidence,
    provider: result.provider,
    matchedAt: new Date()
  };
  run.status = 'ACCEPTED';
  run.rejectReason = '';
  run.runNumber = acceptedCount + 1;
  await run.save();
  return run;
}

/**
 * Re-try any rides that could not be matched earlier (matcher was down).
 */
async function retryPendingMatches(routeId) {
  const pending = await RouteRecordingRun.find({ routeId, status: 'PENDING_MATCH' }).sort({ createdAt: 1 });
  for (const run of pending) {
    // eslint-disable-next-line no-await-in-loop
    await matchAndAcceptRun(run);
  }
  return pending.length;
}

/**
 * After a ride is accepted: refresh the progress counter and, the first time the
 * route has enough rides, build it and hand it to the manager for review.
 * Returns the fresh Route.
 */
async function refreshRouteProgress(routeId) {
  const acceptedCount = await RouteRecordingRun.countDocuments({ routeId, status: 'ACCEPTED' });
  const route = await Route.findOneAndUpdate(
    { routeId, origin: 'RECORDED', isDeleted: false },
    { $set: { 'recording.acceptedRuns': acceptedCount } },
    { new: true }
  );
  if (!route) return null;

  if (route.status === 'RECORDING' && acceptedCount >= route.recording.requiredRuns) {
    // Only the request that wins this flip builds the route.
    const claimed = await Route.findOneAndUpdate(
      { routeId, status: 'RECORDING' },
      { $set: { status: 'PENDING_REVIEW' } },
      { new: true }
    );
    if (claimed) {
      try {
        return await buildRouteFromRuns(claimed);
      } catch (error) {
        await Route.updateOne({ routeId }, { $set: { status: 'RECORDING' } });
        throw error;
      }
    }
  }
  return route;
}

/**
 * Merge a route's accepted rides into one line + stops and store it as the
 * candidate for the manager to confirm. A first recording writes straight to the
 * route's own fields; a re-recording of a live route stages it in recording.candidate
 * so the live line is untouched until confirmation.
 */
async function buildRouteFromRuns(route) {
  const runs = await RouteRecordingRun.find({ routeId: route.routeId, status: 'ACCEPTED' }).sort({ runNumber: 1 });
  const consensus = buildConsensus(runs.map((run) => ({
    id: run._id,
    coords: decodePolyline(run.matched.polyline),
    stops: run.stops.map((s) => ({ lat: s.lat, lng: s.lng, name: s.name })),
    durationSec: run.durationSec
  })));
  if (!consensus) throw new Error('No usable rides to build the route from');

  const polyline = encodePolyline(consensus.coords);
  const wasLive = Boolean(route.pathPolyline);
  const set = {
    'recording.confidence': consensus.confidence,
    'recording.warning': consensus.warning,
    'recording.builtAt': new Date(),
    'recordedMeta.recordedAt': new Date(),
    'recordedMeta.rawPointCount': runs.reduce((n, r) => n + r.points.length, 0),
    'recordedMeta.snapped': true
  };

  if (wasLive) {
    set['recording.candidate'] = {
      pathPolyline: polyline,
      stops: consensus.stops,
      distance: consensus.distanceKm,
      estimatedTime: consensus.estimatedTimeMin
    };
  } else {
    set.pathPolyline = polyline;
    set.stops = consensus.stops;
    set.stopsCount = consensus.stops.length;
    set.distance = consensus.distanceKm;
    set.estimatedTime = consensus.estimatedTimeMin;
  }

  return Route.findOneAndUpdate({ routeId: route.routeId }, { $set: set }, { new: true });
}

// Drop the in-memory path cache entry so riders get the new line straight away.
const invalidatePathCache = (routeId) => {
  if (_pathCache && typeof _pathCache.delete === 'function') _pathCache.delete(String(routeId));
  // The arrival detector caches the route's stops; a confirmed or re-recorded route has new ones.
  stopArrivals.invalidateRoute(String(routeId));
};

/**
 * Who may read a custom (RECORDED) route: its owning manager, a super-admin, the
 * driver of a vehicle on it, and - once it is ACTIVE - a rider with an active
 * enrolment on a driver whose vehicle runs it. Everyone else (including an
 * anonymous caller) is treated as if the route does not exist.
 */
async function canViewCustomRoute(user, route) {
  if (!user || !route) return false;
  if (user.role === 'super-admin') return true;
  if (user.role === 'admin') return String(route.managerId || '') === String(user._id);
  if (user.role === 'driver') {
    return Boolean(await Vehicle.exists({ driverId: user._id, routeId: route.routeId, isDeleted: false }));
  }
  if (user.role === 'user') {
    if (route.status !== 'ACTIVE') return false;
    const driverIds = (await Vehicle.find({ routeId: route.routeId, isDeleted: false }).distinct('driverId')).filter(Boolean);
    if (driverIds.length === 0) return false;
    const profileIds = await RiderProfile.find({ accountId: user._id }).distinct('_id');
    if (profileIds.length === 0) return false;
    return Boolean(await DriverEnrollment.exists({
      studentId: { $in: profileIds },
      driverId: { $in: driverIds },
      status: 'ACTIVE'
    }));
  }
  return false;
}

module.exports = {
  requiredRuns,
  minPoints,
  minMeters,
  createProvisionalRoute,
  generateCustomRouteId,
  sanitizeRunInput,
  checkRunQuality,
  matchAndAcceptRun,
  retryPendingMatches,
  refreshRouteProgress,
  buildRouteFromRuns,
  invalidatePathCache,
  canViewCustomRoute
};
