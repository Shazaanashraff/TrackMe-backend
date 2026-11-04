// Pure arrival maths for a vehicle driving a custom route: given the route's stops and
// the vehicle's fixes, decide when it has arrived at a stop (and is waiting for the
// rider) and when it has left again. No database, no sockets - the notifier wires this
// to those - so it can run on every GPS ping at almost no cost.
//
// Rules, kept deliberately simple so a driver and a parent can predict them:
//  - ARRIVED   : within ARRIVE_RADIUS_M of a stop, moving slower than MAX_ARRIVE_SPEED_MPS
//                (a shuttle driving past a stop at speed has not arrived), with a usable fix.
//  - DEPARTED  : farther than LEAVE_RADIUS_M from the stop it was waiting at. The gap
//                between the two radii stops GPS jitter flipping the state back and forth.
//  - Each stop fires at most once per trip (`done`), so a loop that passes the stop
//    again, or a driver idling at it, never re-notifies a parent.

const ARRIVE_RADIUS_M = 80;
const LEAVE_RADIUS_M = 150;
// ~18 km/h. Crawling in traffic past a stop is not an arrival; pulling up to it is.
const MAX_ARRIVE_SPEED_MPS = 5;
// A fix this vague could be on the next street.
const MAX_FIX_ACCURACY_M = 60;

const METERS_PER_DEG_LAT = 111320;

/** Fast flat-earth distance in metres; accurate to well under a metre at these ranges. */
function metersBetween(aLat, aLng, bLat, bLng) {
  const dLat = (bLat - aLat) * METERS_PER_DEG_LAT;
  const dLng = (bLng - aLng) * METERS_PER_DEG_LAT * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLng);
}

const newTripState = (sessionId) => ({ sessionId, atStop: null, done: new Set() });

const usableStops = (stops) =>
  (Array.isArray(stops) ? stops : []).filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng));

/**
 * Advance one trip's state with one fix.
 * Mutates `state` and returns { arrived: stop|null, departed: stop|null }.
 * @param {{sessionId:string, atStop:null|object, done:Set<number>}} state
 * @param {Array<{order:number,stopName:string,lat:number,lng:number}>} stops
 * @param {{lat:number,lng:number,speed?:number|null,accuracy?:number|null}} fix
 */
function step(state, stops, fix, now = Date.now()) {
  const result = { arrived: null, departed: null };
  if (!Number.isFinite(fix?.lat) || !Number.isFinite(fix?.lng)) return result;

  if (state.atStop) {
    const held = state.atStop;
    if (metersBetween(held.lat, held.lng, fix.lat, fix.lng) > LEAVE_RADIUS_M) {
      state.done.add(held.order);
      state.atStop = null;
      result.departed = held;
    }
    // Still waiting, or just left: either way no new arrival on this fix.
    return result;
  }

  const speed = Number.isFinite(fix.speed) ? fix.speed : null;
  if (speed !== null && speed > MAX_ARRIVE_SPEED_MPS) return result;
  if (Number.isFinite(fix.accuracy) && fix.accuracy > MAX_FIX_ACCURACY_M) return result;

  // Cheap box test first: a stop more than ~0.0012 deg (~130 m) away in either axis cannot
  // be within ARRIVE_RADIUS_M, so the distance is only computed for stops that could be.
  const BOX = 0.0012;
  let nearest = null;
  let nearestMeters = ARRIVE_RADIUS_M;
  for (const stop of stops) {
    if (state.done.has(stop.order)) continue;
    if (Math.abs(stop.lat - fix.lat) > BOX || Math.abs(stop.lng - fix.lng) > BOX) continue;
    const d = metersBetween(stop.lat, stop.lng, fix.lat, fix.lng);
    if (d <= nearestMeters) {
      nearest = stop;
      nearestMeters = d;
    }
  }

  if (nearest) {
    state.atStop = {
      order: nearest.order,
      stopName: nearest.stopName,
      lat: nearest.lat,
      lng: nearest.lng,
      since: now
    };
    result.arrived = state.atStop;
  }
  return result;
}

// A rider belongs to the nearest stop, but only if that stop is within this distance of
// their pickup place; a rider whose pickup is far from every stop belongs to none.
const PICKUP_MATCH_METERS = 250;

/**
 * Work out which stop each rider's pickup place belongs to.
 * @param {Array<{lat:number,lng:number}>} pickups
 * @param {Array<{order:number,lat:number,lng:number}>} stops
 * @returns {Map<number, Array>} stop order -> the pickups assigned to it
 */
function assignPickups(pickups, stops, maxMeters = PICKUP_MATCH_METERS) {
  const byStop = new Map();
  for (const pickup of pickups || []) {
    let best = null;
    let bestMeters = maxMeters;
    for (const stop of stops || []) {
      const d = metersBetween(stop.lat, stop.lng, pickup.lat, pickup.lng);
      if (d <= bestMeters) {
        best = stop;
        bestMeters = d;
      }
    }
    if (!best) continue;
    if (!byStop.has(best.order)) byStop.set(best.order, []);
    byStop.get(best.order).push(pickup);
  }
  return byStop;
}

module.exports = {
  PICKUP_MATCH_METERS,
  assignPickups,
  ARRIVE_RADIUS_M,
  LEAVE_RADIUS_M,
  MAX_ARRIVE_SPEED_MPS,
  MAX_FIX_ACCURACY_M,
  metersBetween,
  newTripState,
  usableStops,
  step
};
