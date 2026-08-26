const VehicleLiveLocation = require('../models/VehicleLiveLocation');

// Session bookkeeping for live vehicles.
//
// The in-memory maps here hold only what *this* process needs to clean up after
// its own sockets: which vehicles a socket is broadcasting for, and any pending
// grace timer. They are never consulted to answer "is this vehicle live" — that
// is the `live` field on the document, because a second instance, a REST call,
// or a process that has just restarted must all get the same answer, and none
// of them can see this process's memory.

// socketId -> Set<vehicleId>
const ownedBySocket = new Map();
// vehicleId -> NodeJS.Timeout
const graceTimers = new Map();

// A driver's socket drops constantly once tracking runs in the background:
// doze, cell handover, an OS process restart. Ending the shift on the first
// disconnect would flap every rider's map, so a dropped socket has this long to
// come back before the vehicle is marked offline.
const DISCONNECT_GRACE_MS = Number(process.env.LIVE_DISCONNECT_GRACE_MS) || 30_000;

// A fix older than this means nobody is really broadcasting — the recovery path
// for a process that died holding sessions and never ran its disconnect
// handlers. Must exceed the driver app's emit interval by a wide margin.
const STALE_AFTER_MS = Number(process.env.LIVE_STALE_AFTER_MS) || 90_000;
const SWEEP_INTERVAL_MS = Number(process.env.LIVE_SWEEP_INTERVAL_MS) || 60_000;

function adopt(socketId, vehicleId) {
  cancelGrace(vehicleId);
  if (!ownedBySocket.has(socketId)) ownedBySocket.set(socketId, new Set());
  ownedBySocket.get(socketId).add(vehicleId);
}

function release(socketId, vehicleId) {
  const owned = ownedBySocket.get(socketId);
  if (!owned) return;
  owned.delete(vehicleId);
  if (owned.size === 0) ownedBySocket.delete(socketId);
}

function ownedBy(socketId) {
  return [...(ownedBySocket.get(socketId) || [])];
}

function cancelGrace(vehicleId) {
  const timer = graceTimers.get(vehicleId);
  if (!timer) return false;
  clearTimeout(timer);
  graceTimers.delete(vehicleId);
  return true;
}

// Marks a vehicle offline, but only if it is still live — the conditional makes
// this idempotent when a grace timer and the sweeper race, or when two
// instances both notice.
async function endSession(vehicleId, reason) {
  return VehicleLiveLocation.findOneAndUpdate(
    { vehicleId, live: true },
    { $set: { live: false, endedAt: new Date(), endedReason: reason } },
    { new: true }
  );
}

// Schedules the offline transition. `onEnded` is called only if the timer
// actually fires and a live session was found, so callers can emit
// vehicle:status without checking first.
function scheduleGrace(vehicleId, onEnded, graceMs = DISCONNECT_GRACE_MS) {
  cancelGrace(vehicleId);
  const timer = setTimeout(async () => {
    graceTimers.delete(vehicleId);
    try {
      const ended = await endSession(vehicleId, 'DRIVER_DISCONNECTED');
      if (ended) await onEnded?.(vehicleId, ended);
    } catch (error) {
      console.error('[live] grace expiry failed', vehicleId, error.message);
    }
  }, graceMs);
  // Do not hold the process open for a timer that only matters while running.
  timer.unref?.();
  graceTimers.set(vehicleId, timer);
  return timer;
}

async function sweepStale(onEnded, staleAfterMs = STALE_AFTER_MS) {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const stale = await VehicleLiveLocation.find({ live: true, receivedAt: { $lt: cutoff } })
    .select('vehicleId')
    .lean();

  const ended = [];
  for (const doc of stale) {
    // eslint-disable-next-line no-await-in-loop
    const result = await endSession(doc.vehicleId, 'STALE_TIMEOUT');
    if (result) {
      ended.push(doc.vehicleId);
      // eslint-disable-next-line no-await-in-loop
      await onEnded?.(doc.vehicleId, result);
    }
  }
  return ended;
}

function startSweeper(onEnded, intervalMs = SWEEP_INTERVAL_MS) {
  const handle = setInterval(() => {
    sweepStale(onEnded).catch((error) => console.error('[live] sweep failed', error.message));
  }, intervalMs);
  handle.unref?.();
  return handle;
}

// Test seam: clears timers and ownership without touching the database.
function reset() {
  for (const timer of graceTimers.values()) clearTimeout(timer);
  graceTimers.clear();
  ownedBySocket.clear();
}

module.exports = {
  adopt,
  release,
  ownedBy,
  cancelGrace,
  scheduleGrace,
  endSession,
  sweepStale,
  startSweeper,
  reset,
  DISCONNECT_GRACE_MS,
  STALE_AFTER_MS
};
