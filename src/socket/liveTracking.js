const crypto = require('crypto');
const Vehicle = require('../models/Vehicle');
const Driver = require('../models/Driver');
const DriverEnrollment = require('../models/DriverEnrollment');
const RiderProfile = require('../models/RiderProfile');
const VehicleLiveLocation = require('../models/VehicleLiveLocation');
const rateLimit = require('../utils/socketRateLimit');
const liveVehicles = require('../utils/liveVehicles');
const { dayTripId } = require('../utils/tripId');

// Live vehicle location: the driver broadcasts, enrolled riders and the owning
// manager watch.
//
// Everything fans out through one room per vehicle, `vehicle:<vehicleId>`, keyed
// on the *business* id (Vehicle.vehicleId, "VH-001") rather than the ObjectId.
// The server resolves whatever a client sends to that id before joining or
// emitting — a driver sending an _id and a rider sending a vehicleId would
// otherwise sit in two different rooms and never see each other.

const MAX_SUBSCRIPTIONS_PER_SOCKET = 25;
// A device clock further out than this is not believable, so its timestamp is
// discarded in favour of the server's.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

const roomFor = (vehicleId) => `vehicle:${vehicleId}`;

const fail = (code, error) => ({ success: false, code, error });

const debug = process.env.SOCKET_DEBUG === '1'
  ? (...args) => console.log(...args)
  : () => {};

function validCoord(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90
    && lng >= -180 && lng <= 180
    // (0,0) is in the Atlantic and is what a failed fix serialises to far more
    // often than it is a real position for a shuttle.
    && !(lat === 0 && lng === 0)
  );
}

// Trusts the device clock only when it is plausible; otherwise the server's.
function resolveRecordedAt(timestamp, now = Date.now()) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return new Date(now);
  if (Math.abs(value - now) > CLOCK_SKEW_TOLERANCE_MS) return new Date(now);
  return new Date(value);
}

function locationPayload(doc) {
  if (!doc || doc.lat === null || doc.lng === null) return null;
  return {
    lat: doc.lat,
    lng: doc.lng,
    accuracy: doc.accuracy ?? null,
    speed: doc.speed ?? null,
    heading: doc.heading ?? null,
    recordedAt: doc.recordedAt || doc.receivedAt,
    receivedAt: doc.receivedAt
  };
}

function vehicleSummary(vehicle) {
  return {
    vehicleId: vehicle.vehicleId,
    vehicleName: vehicle.vehicleName || '',
    numberPlate: vehicle.numberPlate || '',
    routeId: vehicle.routeId || '',
    serviceType: vehicle.serviceType || null
  };
}

// Resolves the vehicle a driver is allowed to broadcast for. Accepts either id
// form from the client but always answers with the canonical document.
async function driverVehicle(vehicleIdOrRef, driverId) {
  const byBusinessId = await Vehicle.findOne({
    vehicleId: vehicleIdOrRef,
    driverId,
    isDeleted: false
  });
  if (byBusinessId) return byBusinessId;

  if (!/^[a-f\d]{24}$/i.test(String(vehicleIdOrRef || ''))) return null;
  return Vehicle.findOne({ _id: vehicleIdOrRef, driverId, isDeleted: false });
}

async function findVehicle(vehicleIdOrRef) {
  const byBusinessId = await Vehicle.findOne({ vehicleId: vehicleIdOrRef, isDeleted: false });
  if (byBusinessId) return byBusinessId;
  if (!/^[a-f\d]{24}$/i.test(String(vehicleIdOrRef || ''))) return null;
  return Vehicle.findOne({ _id: vehicleIdOrRef, isDeleted: false });
}

// May this socket watch this vehicle? Returns null when allowed, or the ack to
// send back when not.
async function watchRefusal(socket, vehicle, riderId) {
  const role = socket.userRole;

  if (role === 'user') {
    if (!riderId) return fail('INVALID_INPUT', 'A rider is required');
    const owned = await RiderProfile.exists({
      _id: riderId,
      accountId: socket.userId,
      isActive: { $ne: false }
    });
    if (!owned) return fail('RIDER_NOT_FOUND', 'Rider not found');

    if (!vehicle.driverId) return fail('NOT_ENROLLED', 'This vehicle has no driver assigned');

    // Enrolment is to a driver; the vehicle's driver is the join. Checking the
    // driver rather than the vehicle keeps this correct when a manager moves a
    // driver between vehicles mid-term.
    const enrolled = await DriverEnrollment.exists({
      studentId: riderId,
      driverId: vehicle.driverId,
      status: 'ACTIVE'
    });
    if (!enrolled) return fail('NOT_ENROLLED', 'This rider is not enrolled with this shuttle');
    return null;
  }

  if (role === 'admin') {
    // Vehicle.managerId is the authoritative assignment (unlike the
    // denormalised copy on DriverEnrollment), so it is safe to scope on here.
    if (String(vehicle.managerId || '') !== String(socket.userId)) {
      return fail('FORBIDDEN', 'This vehicle belongs to another manager');
    }
    return null;
  }

  if (role === 'super-admin') return null;

  if (role === 'driver') {
    if (String(vehicle.driverId || '') !== String(socket.userId)) {
      return fail('FORBIDDEN', 'This is not your vehicle');
    }
    return null;
  }

  return fail('FORBIDDEN', 'Not allowed to watch this vehicle');
}

function registerLiveTracking(io, socket) {
  const emitStatus = async (vehicleId, live, reason) => {
    io.to(roomFor(vehicleId)).emit('vehicle:status', {
      vehicleId,
      live,
      reason,
      at: new Date().toISOString()
    });
  };

  socket.on('driver:start-tracking', async (data, callback) => {
    try {
      if (!rateLimit.check(socket.id, 'driver:start-tracking')) {
        return callback?.(fail('RATE_LIMITED', 'Slow down'));
      }
      if (socket.userRole !== 'driver') {
        return callback?.(fail('FORBIDDEN_ROLE', 'Only a driver can start tracking'));
      }

      const requested = data?.vehicleId;
      if (!requested || typeof requested !== 'string') {
        return callback?.(fail('INVALID_INPUT', 'A vehicle is required'));
      }

      const vehicle = await driverVehicle(requested, socket.userId);
      // One code for "no such vehicle" and "not yours" — distinguishing them
      // would let a driver enumerate the fleet.
      if (!vehicle) return callback?.(fail('VEHICLE_NOT_FOUND', 'Vehicle not found'));

      const vehicleId = vehicle.vehicleId;
      const startedAt = new Date();
      const sessionId = crypto.randomUUID();

      // Cached so the per-fix path does no vehicle lookup at all — the previous
      // implementation read Vehicle and Route on every ping.
      socket.data.trackedVehicles = socket.data.trackedVehicles || new Map();
      socket.data.trackedVehicles.set(vehicleId, {
        vehicleId,
        vehicleRef: vehicle._id,
        driverId: vehicle.driverId,
        managerId: vehicle.managerId || null,
        routeId: vehicle.routeId || '',
        vehicleName: vehicle.vehicleName || '',
        numberPlate: vehicle.numberPlate || '',
        serviceType: vehicle.serviceType || null,
        sessionId
      });

      liveVehicles.adopt(socket.id, vehicleId);

      await VehicleLiveLocation.findOneAndUpdate(
        { vehicleId },
        {
          $set: {
            vehicleRef: vehicle._id,
            driverId: vehicle.driverId,
            managerId: vehicle.managerId || null,
            routeId: vehicle.routeId || '',
            live: true,
            sessionId,
            tripId: dayTripId(vehicleId, startedAt),
            startedAt,
            endedAt: null,
            endedReason: null,
            receivedAt: startedAt
          }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      socket.join(roomFor(vehicleId));
      await emitStatus(vehicleId, true, 'DRIVER_STARTED');
      debug(`🟢 ${vehicleId} live (driver ${socket.userId})`);

      return callback?.({
        success: true,
        data: {
          vehicleId,
          routeId: vehicle.routeId || '',
          vehicleName: vehicle.vehicleName || '',
          numberPlate: vehicle.numberPlate || '',
          sessionId,
          startedAt: startedAt.toISOString()
        }
      });
    } catch (error) {
      console.error('driver:start-tracking failed:', error);
      return callback?.(fail('SERVER_ERROR', 'Could not start tracking'));
    }
  });

  socket.on('driver:location', async (data, callback) => {
    try {
      if (!rateLimit.check(socket.id, 'driver:location')) {
        return callback?.(fail('RATE_LIMITED', 'Too many updates'));
      }
      if (socket.userRole !== 'driver') {
        return callback?.(fail('FORBIDDEN_ROLE', 'Only a driver can send a location'));
      }

      const requested = data?.vehicleId;
      const lat = Number(data?.lat);
      const lng = Number(data?.lng);

      if (!requested || typeof requested !== 'string') {
        return callback?.(fail('INVALID_INPUT', 'A vehicle is required'));
      }
      if (!validCoord(lat, lng)) {
        return callback?.(fail('INVALID_COORDS', 'Latitude and longitude are out of range'));
      }

      // A fix can outlive its session: a redeploy drops every socket, and the
      // driver app replays its buffer on reconnect. Re-adopting is the correct
      // response — refusing would silently end a shift that is plainly running.
      let session = socket.data.trackedVehicles?.get(requested);
      if (!session) {
        const vehicle = await driverVehicle(requested, socket.userId);
        if (!vehicle) return callback?.(fail('VEHICLE_NOT_FOUND', 'Vehicle not found'));
        session = {
          vehicleId: vehicle.vehicleId,
          vehicleRef: vehicle._id,
          driverId: vehicle.driverId,
          managerId: vehicle.managerId || null,
          routeId: vehicle.routeId || '',
          vehicleName: vehicle.vehicleName || '',
          numberPlate: vehicle.numberPlate || '',
          serviceType: vehicle.serviceType || null,
          sessionId: crypto.randomUUID()
        };
        socket.data.trackedVehicles = socket.data.trackedVehicles || new Map();
        socket.data.trackedVehicles.set(session.vehicleId, session);
        socket.join(roomFor(session.vehicleId));
        await emitStatus(session.vehicleId, true, 'DRIVER_STARTED');
      }

      const { vehicleId } = session;
      liveVehicles.adopt(socket.id, vehicleId);

      const now = Date.now();
      const recordedAt = resolveRecordedAt(data?.timestamp, now);
      const receivedAt = new Date(now);

      // An offline buffer replays oldest-first on reconnect. Writing those would
      // walk every watcher's marker backwards through the last 50 positions, so
      // an older fix is accepted and dropped. It must ACK success: a NACK would
      // send the client's isNackResponse path straight back to re-buffering it.
      const current = await VehicleLiveLocation.findOne({ vehicleId })
        .select('recordedAt')
        .lean();
      if (current?.recordedAt && recordedAt < current.recordedAt) {
        return callback?.({ success: true, data: { acceptedAt: receivedAt.toISOString(), stale: true } });
      }

      const update = {
        vehicleRef: session.vehicleRef,
        driverId: session.driverId,
        managerId: session.managerId,
        routeId: data?.routeId || session.routeId || '',
        lat,
        lng,
        accuracy: Number.isFinite(Number(data?.accuracy)) ? Number(data.accuracy) : null,
        speed: Number.isFinite(Number(data?.speed)) ? Number(data.speed) : null,
        heading: Number.isFinite(Number(data?.heading)) ? Number(data.heading) : null,
        recordedAt,
        receivedAt,
        live: true,
        sessionId: session.sessionId,
        tripId: dayTripId(vehicleId, receivedAt),
        endedAt: null,
        endedReason: null
      };

      await VehicleLiveLocation.findOneAndUpdate(
        { vehicleId },
        { $set: update },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      io.to(roomFor(vehicleId)).emit('vehicle:update', {
        vehicleId,
        routeId: update.routeId,
        vehicleName: session.vehicleName,
        numberPlate: session.numberPlate,
        serviceType: session.serviceType,
        lat,
        lng,
        accuracy: update.accuracy,
        speed: update.speed,
        heading: update.heading,
        recordedAt: recordedAt.toISOString(),
        receivedAt: receivedAt.toISOString(),
        // Alias kept so builds already in the field, which read `timestamp`,
        // keep working against the new payload.
        timestamp: recordedAt.toISOString(),
        driverId: String(session.driverId || ''),
        sessionId: session.sessionId,
        live: true
      });

      return callback?.({ success: true, data: { acceptedAt: receivedAt.toISOString() } });
    } catch (error) {
      console.error('driver:location failed:', error);
      return callback?.(fail('SERVER_ERROR', 'Could not record location'));
    }
  });

  socket.on('driver:stop-tracking', async (data, callback) => {
    try {
      if (!rateLimit.check(socket.id, 'driver:stop-tracking')) {
        return callback?.(fail('RATE_LIMITED', 'Slow down'));
      }
      if (socket.userRole !== 'driver') {
        return callback?.(fail('FORBIDDEN_ROLE', 'Only a driver can stop tracking'));
      }

      const requested = data?.vehicleId;
      if (!requested || typeof requested !== 'string') {
        return callback?.(fail('INVALID_INPUT', 'A vehicle is required'));
      }

      const session = socket.data.trackedVehicles?.get(requested);
      const vehicle = session ? null : await driverVehicle(requested, socket.userId);
      if (!session && !vehicle) return callback?.(fail('VEHICLE_NOT_FOUND', 'Vehicle not found'));

      const vehicleId = session?.vehicleId || vehicle.vehicleId;

      // Explicit stop is immediate — the grace period exists for connections
      // that drop, not for a driver who has said they are finished.
      liveVehicles.cancelGrace(vehicleId);
      liveVehicles.release(socket.id, vehicleId);
      socket.data.trackedVehicles?.delete(vehicleId);

      await liveVehicles.endSession(vehicleId, 'DRIVER_STOPPED');
      await emitStatus(vehicleId, false, 'DRIVER_STOPPED');
      socket.leave(roomFor(vehicleId));
      debug(`🔴 ${vehicleId} offline (driver stopped)`);

      return callback?.({ success: true });
    } catch (error) {
      console.error('driver:stop-tracking failed:', error);
      return callback?.(fail('SERVER_ERROR', 'Could not stop tracking'));
    }
  });

  socket.on('vehicle:subscribe', async (data, callback) => {
    try {
      if (!rateLimit.check(socket.id, 'vehicle:subscribe')) {
        return callback?.(fail('RATE_LIMITED', 'Slow down'));
      }

      const requested = data?.vehicleId;
      const riderId = data?.riderId || data?.studentId;
      if (!requested || typeof requested !== 'string') {
        return callback?.(fail('INVALID_INPUT', 'A vehicle is required'));
      }

      socket.data.watching = socket.data.watching || new Set();
      if (socket.data.watching.size >= MAX_SUBSCRIPTIONS_PER_SOCKET
        && !socket.data.watching.has(requested)) {
        return callback?.(fail('TOO_MANY_SUBSCRIPTIONS', 'Too many vehicles watched at once'));
      }

      const vehicle = await findVehicle(requested);
      if (!vehicle) return callback?.(fail('VEHICLE_NOT_FOUND', 'Vehicle not found'));

      const refusal = await watchRefusal(socket, vehicle, riderId);
      if (refusal) return callback?.(refusal);

      const vehicleId = vehicle.vehicleId;
      socket.join(roomFor(vehicleId));
      socket.data.watching.add(vehicleId);

      const [current, driver] = await Promise.all([
        VehicleLiveLocation.findOne({ vehicleId }).lean(),
        vehicle.driverId ? Driver.findById(vehicle.driverId).select('name').lean() : null
      ]);

      return callback?.({
        success: true,
        data: {
          vehicleId,
          live: Boolean(current?.live),
          location: locationPayload(current),
          vehicle: vehicleSummary(vehicle),
          driver: driver ? { _id: String(driver._id), name: driver.name } : null
        }
      });
    } catch (error) {
      console.error('vehicle:subscribe failed:', error);
      return callback?.(fail('SERVER_ERROR', 'Could not subscribe'));
    }
  });

  socket.on('vehicle:unsubscribe', (data, callback) => {
    try {
      if (!rateLimit.check(socket.id, 'vehicle:unsubscribe')) {
        return callback?.(fail('RATE_LIMITED', 'Slow down'));
      }
      const vehicleId = data?.vehicleId;
      if (!vehicleId) return callback?.(fail('INVALID_INPUT', 'A vehicle is required'));

      socket.leave(roomFor(vehicleId));
      socket.data.watching?.delete(vehicleId);
      return callback?.({ success: true });
    } catch (error) {
      console.error('vehicle:unsubscribe failed:', error);
      return callback?.(fail('SERVER_ERROR', 'Could not unsubscribe'));
    }
  });

  socket.on('disconnect', () => {
    rateLimit.forget(socket.id);
    for (const vehicleId of liveVehicles.ownedBy(socket.id)) {
      liveVehicles.release(socket.id, vehicleId);
      liveVehicles.scheduleGrace(vehicleId, async (id) => {
        await emitStatus(id, false, 'DRIVER_DISCONNECTED');
        debug(`🔴 ${id} offline (disconnect grace expired)`);
      });
    }
  });
}

module.exports = {
  registerLiveTracking,
  roomFor,
  validCoord,
  resolveRecordedAt,
  MAX_SUBSCRIPTIONS_PER_SOCKET
};
