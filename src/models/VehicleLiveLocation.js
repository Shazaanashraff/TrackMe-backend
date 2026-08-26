const mongoose = require('mongoose');

// Where a vehicle is right now — one document per vehicle, overwritten on every
// accepted fix.
//
// Deliberately not an append-only trail. A trail costs one insert per driver
// every couple of seconds and needs a TTL to stay bounded (the model this
// replaces had neither, and grew without limit). What every screen actually
// asks is "where is this shuttle now", which one upserted row answers for a
// late-joining rider, a manager opening the map, or a REST caller with no
// socket — at a fixed size per vehicle.
//
// `live` is the authoritative answer to "is this vehicle broadcasting". It lives
// on the document rather than in process memory so any instance, any REST call,
// and a process that has just restarted all read the same truth.
const vehicleLiveLocationSchema = new mongoose.Schema(
  {
    // The business id (Vehicle.vehicleId, e.g. "VH-001") — also the room key.
    // Unique because this collection is a current-state table, not a log.
    vehicleId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    vehicleRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
      default: null
    },
    // Who was driving when this position was recorded. A vehicle can change
    // hands between shifts, so this is per-session rather than a mirror of
    // Vehicle.driverId.
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      default: null,
      index: true
    },
    // Denormalised for the manager's fleet query only. Never an authorization
    // source — that is checked against Vehicle.managerId, which is the
    // authoritative assignment.
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Manager',
      default: null,
      index: true
    },
    // Informational. Vehicle.routeId is a string route code that is often '',
    // so nothing here may depend on it being present.
    routeId: { type: String, default: '' },

    // Nullable on purpose: a driver goes live the moment they press GO, which is
    // before the first GPS fix arrives. A watcher joining in that window needs
    // "on duty, waiting for a fix" rather than an empty result.
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    accuracy: { type: Number, default: null },
    speed: { type: Number, default: null },
    heading: { type: Number, default: null },

    // The device clock, clamped by the server when it is implausible. Used to
    // reject a replayed offline buffer that would otherwise walk a marker
    // backwards through the last 50 positions.
    recordedAt: { type: Date, default: null },
    // The server clock. This is what staleness is measured against — a device
    // whose clock is wrong must not be able to keep itself looking fresh.
    receivedAt: { type: Date, default: Date.now, index: true },

    live: { type: Boolean, default: false, index: true },

    // One id per GO press, so a watcher can tell a resumed shift from a new one.
    sessionId: { type: String, default: null },
    // dayTripId(vehicleId) — the same identity boardingController stamps on
    // scans, so attendance and location describe the same trip.
    tripId: { type: String, default: null },

    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endedReason: {
      type: String,
      enum: ['DRIVER_STOPPED', 'DRIVER_DISCONNECTED', 'STALE_TIMEOUT', null],
      default: null
    }
  },
  { timestamps: true }
);

// The manager map's only query: every live vehicle in a fleet.
vehicleLiveLocationSchema.index({ managerId: 1, live: 1 });
// The staleness sweeper's query.
vehicleLiveLocationSchema.index({ live: 1, receivedAt: -1 });

module.exports = mongoose.model('VehicleLiveLocation', vehicleLiveLocationSchema);
