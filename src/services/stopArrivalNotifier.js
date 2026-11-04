// Tells parents when their shuttle has pulled up to their stop.
//
// Fed by every driver GPS fix (socket/liveTracking.js). The per-fix path touches no
// database: a custom route's stops are cached in memory, and the arrival maths is a
// handful of float comparisons (utils/stopArrival.js). Only an actual arrival - at most
// once per stop per trip - reads the enrolled riders and writes notifications.
//
// Scope: ACTIVE custom (RECORDED) routes only. A route still being recorded has no
// confirmed stops, and the long-standing system routes are not part of this feature.
//
// Which parent a stop belongs to: a rider's pickup place (chosen on the enrolment, else
// the rider's default pickup place) is matched to the NEAREST stop within
// PICKUP_MATCH_METERS. A rider with no pickup place still sees the stops and the
// "waiting" banner for any stop, but is not pushed for one.

const Route = require('../models/Route');
const DriverEnrollment = require('../models/DriverEnrollment');
const RiderProfile = require('../models/RiderProfile');
const HouseholdPlace = require('../models/HouseholdPlace');
const User = require('../models/User');
const Notification = require('../models/Notification');
const pushHelper = require('../utils/pushHelper');
const arrival = require('../utils/stopArrival');

const STOP_CACHE_TTL_MS = 5 * 60 * 1000;
// A route that has no stops to watch is re-checked at this interval, so a freshly
// confirmed route starts working even if nobody invalidated the cache.
const NO_STOPS_TTL_MS = 60 * 1000;
const TRIP_IDLE_PRUNE_MS = 12 * 60 * 60 * 1000;
const MAX_CACHED_ROUTES = 500;

const stopCache = new Map(); // routeId -> { stops: Stop[] | null, at: number, loading?: Promise }
const trips = new Map(); // vehicleId -> { state, driverId, assignment?: Promise<Map>, seenAt }

const roomFor = (vehicleId) => `vehicle:${vehicleId}`;

async function loadStops(routeId) {
  const route = await Route.findOne({ routeId, origin: 'RECORDED', status: 'ACTIVE', isDeleted: false })
    .select('stops')
    .lean();
  const stops = arrival.usableStops(route?.stops).map((s) => ({
    order: s.order,
    stopName: s.stopName || `Stop ${s.order}`,
    lat: s.lat,
    lng: s.lng
  }));
  return stops.length ? stops : null;
}

/** The route's stops from cache, loading (once, shared by concurrent callers) on a miss. */
async function stopsFor(routeId) {
  if (!routeId) return null;
  const hit = stopCache.get(routeId);
  if (hit) {
    if (hit.loading) return hit.loading;
    const ttl = hit.stops ? STOP_CACHE_TTL_MS : NO_STOPS_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.stops;
  }
  // One entry per route a live vehicle runs; this is only a backstop against unbounded growth.
  if (stopCache.size >= MAX_CACHED_ROUTES) stopCache.delete(stopCache.keys().next().value);
  const loading = loadStops(routeId)
    .then((stops) => {
      stopCache.set(routeId, { stops, at: Date.now() });
      return stops;
    })
    .catch((error) => {
      stopCache.delete(routeId);
      throw error;
    });
  stopCache.set(routeId, { stops: null, at: Date.now(), loading });
  return loading;
}

/** Drop a route's cached stops (call when the manager confirms or re-records it). */
function invalidateRoute(routeId) {
  stopCache.delete(routeId);
}

/** Every active rider on this driver with a pickup position, one query set per trip. */
async function loadPickups(driverId) {
  const enrollments = await DriverEnrollment.find({ driverId, status: 'ACTIVE' })
    .select('studentId pickupPlaceId')
    .lean();
  if (enrollments.length === 0) return [];

  const riders = await RiderProfile.find({ _id: { $in: enrollments.map((e) => e.studentId) }, isActive: { $ne: false } })
    .select('accountId fullName defaultPickupPlaceId')
    .lean();
  const riderById = new Map(riders.map((r) => [String(r._id), r]));

  const placeIdFor = (enrollment) => {
    const rider = riderById.get(String(enrollment.studentId));
    return enrollment.pickupPlaceId || rider?.defaultPickupPlaceId || null;
  };
  const placeIds = [...new Set(enrollments.map(placeIdFor).filter(Boolean).map(String))];
  const places = placeIds.length
    ? await HouseholdPlace.find({ _id: { $in: placeIds } }).select('coordinates').lean()
    : [];
  const placeById = new Map(places.map((p) => [String(p._id), p]));

  const pickups = [];
  for (const enrollment of enrollments) {
    const rider = riderById.get(String(enrollment.studentId));
    const place = placeById.get(String(placeIdFor(enrollment) || ''));
    if (!rider || !place) continue;
    pickups.push({
      studentId: String(rider._id),
      accountId: String(rider.accountId),
      fullName: rider.fullName,
      lat: place.coordinates.lat,
      lng: place.coordinates.lng
    });
  }
  return pickups;
}

function tripFor(session, now) {
  const existing = trips.get(session.vehicleId);
  if (existing && existing.state.sessionId === session.sessionId) {
    existing.seenAt = now;
    return existing;
  }
  // A new shift on this vehicle starts with a clean slate; also sweep trips whose
  // vehicle never reported an end (process restarts are the usual cause).
  for (const [id, trip] of trips) {
    if (now - trip.seenAt > TRIP_IDLE_PRUNE_MS) trips.delete(id);
  }
  const trip = {
    state: arrival.newTripState(session.sessionId),
    driverId: session.driverId,
    assignment: null,
    seenAt: now
  };
  trips.set(session.vehicleId, trip);
  return trip;
}

const payload = (session, stop, extra = {}) => ({
  vehicleId: session.vehicleId,
  routeId: session.routeId,
  stopOrder: stop.order,
  stopName: stop.stopName,
  lat: stop.lat,
  lng: stop.lng,
  at: new Date().toISOString(),
  ...extra
});

async function notifyRider(session, stop, rider) {
  const eventId = `arrival:${session.sessionId}:${stop.order}:${rider.studentId}`;
  const vehicleName = session.vehicleName || session.vehicleId;
  try {
    await Notification.create({
      eventId,
      userId: rider.accountId,
      studentId: rider.studentId,
      type: 'VEHICLE_ARRIVAL',
      title: `${vehicleName} has arrived`,
      message: `Your driver is waiting at ${stop.stopName} for ${rider.fullName}.`,
      data: {
        studentId: rider.studentId,
        vehicleId: session.vehicleId,
        routeId: session.routeId
      },
      priority: 'HIGH'
    });
  } catch (error) {
    // Same stop, same trip, same rider: already told. Do not push twice.
    if (error?.code === 11000) return;
    throw error;
  }
  const account = await User.findById(rider.accountId).select('pushTokens identityId').lean();
  await pushHelper.sendArrivalPush(
    { _id: rider.studentId, fullName: rider.fullName },
    account,
    { vehicleName, stopName: stop.stopName, routeId: session.routeId, vehicleId: session.vehicleId }
  );
}

async function onArrived(io, session, trip, stop) {
  const eventBase = payload(session, stop, { arrivalId: `${session.sessionId}:${stop.order}` });
  // Everyone watching the shuttle sees where it is waiting straight away.
  io.to(roomFor(session.vehicleId)).emit('vehicle:arrival', { ...eventBase, forYou: false });

  if (!trip.assignment) {
    trip.assignment = loadPickups(trip.driverId).then(async (pickups) => {
      const stops = await stopsFor(session.routeId);
      return arrival.assignPickups(pickups, stops || []);
    });
  }
  const riders = (await trip.assignment).get(stop.order) || [];
  if (riders.length === 0) return;

  if (trip.state.atStop && trip.state.atStop.order === stop.order) {
    trip.state.atStop.riderIds = new Set(riders.map((r) => r.studentId));
  }

  // The parents of the riders at this stop also get a targeted event (their sockets are
  // in a `student:<id>` room), which the app shows as "your stop".
  const rooms = riders.map((r) => `student:${r.studentId}`);
  io.to(rooms).emit('vehicle:arrival', { ...eventBase, forYou: true });

  await Promise.allSettled(riders.map((rider) => notifyRider(session, stop, rider)))
    .then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') console.error('Arrival notification failed:', r.reason?.message || r.reason);
      }
    });
}

/**
 * Process one driver fix. Safe to call on every ping; resolves quickly when the vehicle's
 * route has no confirmed custom stops.
 * @param {import('socket.io').Server} io
 * @param {{vehicleId,driverId,routeId,sessionId,vehicleName}} session
 * @param {{lat:number,lng:number,speed?:number|null,accuracy?:number|null}} fix
 */
async function handleFix(io, session, fix) {
  if (!io || !session?.routeId) return;
  const stops = await stopsFor(session.routeId);
  if (!stops) return;

  const trip = tripFor(session, Date.now());
  const { arrived, departed } = arrival.step(trip.state, stops, fix);

  if (departed) {
    io.to(roomFor(session.vehicleId)).emit('vehicle:departure', payload(session, departed));
  }
  if (arrived) await onArrived(io, session, trip, arrived);
}

/** The stop a vehicle is currently waiting at, for a rider who has just subscribed. */
function currentStop(vehicleId, riderId) {
  const held = trips.get(vehicleId)?.state.atStop;
  if (!held) return null;
  return {
    stopOrder: held.order,
    stopName: held.stopName,
    lat: held.lat,
    lng: held.lng,
    since: new Date(held.since).toISOString(),
    forYou: Boolean(riderId && held.riderIds?.has(String(riderId)))
  };
}

/** The shift ended (driver stopped, disconnected past the grace, or timed out). */
function endTrip(io, vehicleId) {
  const trip = trips.get(vehicleId);
  if (!trip) return;
  trips.delete(vehicleId);
  const held = trip.state.atStop;
  if (held && io) {
    io.to(roomFor(vehicleId)).emit('vehicle:departure', {
      vehicleId,
      stopOrder: held.order,
      stopName: held.stopName,
      lat: held.lat,
      lng: held.lng,
      at: new Date().toISOString()
    });
  }
}

/** Test hook. */
function reset() {
  stopCache.clear();
  trips.clear();
}

module.exports = { handleFix, currentStop, endTrip, invalidateRoute, reset, stopsFor };
