// Driver-facing QR scan endpoint — see docs/features/qr-attendance/QR_SYSTEM.md.
const Vehicle = require('../models/Vehicle');
const Route = require('../models/Route');
const BoardingEvent = require('../models/BoardingEvent');
const { verifyQr } = require('../utils/qrToken');
const { sendBoardingPush } = require('../utils/pushHelper');
const DriverEnrollment = require('../models/DriverEnrollment');
const User = require('../models/User');
const Notification = require('../models/Notification');

// Debounce window: a repeat scan of the SAME type for the SAME student on the SAME
// vehicle within this many seconds is treated as a duplicate (idempotent replay, e.g.
// a driver double-tapping or an offline-queue resend) rather than a new event.
// Finalized default per todos/active/001-qr-attendance-foundation.md "Blocked" section.
const DEBOUNCE_SECONDS = Number(process.env.QR_SCAN_DEBOUNCE_SECONDS) || 30;

function dayTripId(vehicleId, at = new Date()) {
  return `${vehicleId}#${at.toISOString().slice(0, 10)}`;
}

// A buggy GPS reading or tampered request could otherwise store a boarding
// event at an impossible location. Out-of-range values are dropped (treated
// the same as absent) rather than rejecting the whole scan, since lat/lng are
// optional on this endpoint.
function validCoordinate(value, min, max, label) {
  if (typeof value !== 'number') return null;
  if (value < min || value > max) {
    console.warn(`[boardingController] Discarding out-of-range boarding-scan ${label}: ${value}`);
    return null;
  }
  return value;
}

function eventPayload(event) {
  return {
    eventId: String(event._id),
    studentId: String(event.studentId),
    vehicleId: event.vehicleId,
    routeId: event.routeId,
    type: event.type,
    timestamp: event.timestamp,
    tripId: event.tripId,
    source: event.source
  };
}

// @desc    Driver scans a rider's QR to record a BOARD or ALIGHT event. Requires the
//          scanned vehicle's route to have QR attendance enabled by its manager.
// @route   POST /api/driver/boarding/scan
// body: { token, vehicleId, type?: 'BOARD'|'ALIGHT', lat?, lng?, tripId? }
// `type` explicit overrides toggle inference; omit it to auto-toggle off the
// rider's last event within the resolved trip window.
exports.scanBoarding = async (req, res, next) => {
  try {
    const { token, vehicleId, lat, lng } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, message: 'token is required' });
    }
    if (!vehicleId || typeof vehicleId !== 'string') {
      return res.status(400).json({ success: false, message: 'vehicleId is required' });
    }

    const verification = await verifyQr(token);
    if (!verification.valid) {
      return res.status(401).json({ success: false, message: `Invalid QR token: ${verification.reason}` });
    }
    const { student } = verification;

    const vehicle = await Vehicle.findOne({ vehicleId, driverId: req.user._id, isDeleted: false });
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found or not assigned to you' });
    }

    const route = await Route.findOne({ routeId: vehicle.routeId, isDeleted: false });
    if (!route?.qrEnabled) {
      return res.status(403).json({ success: false, message: 'QR attendance is not enabled for this route' });
    }

    const activeEnrollment = await DriverEnrollment.exists({
      studentId: student._id,
      driverId: req.user._id,
      status: 'ACTIVE'
    });
    if (!activeEnrollment) {
      return res.status(403).json({ success: false, message: 'This student is not enrolled with your shuttle' });
    }

    const tripId = req.body?.tripId ? String(req.body.tripId) : dayTripId(vehicleId);

    let type = typeof req.body?.type === 'string' ? req.body.type.toUpperCase() : null;
    if (type && !BoardingEvent.TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be BOARD or ALIGHT' });
    }
    if (!type) {
      const lastForTrip = await BoardingEvent.findOne({ studentId: student._id, tripId })
        .sort({ timestamp: -1 });
      type = lastForTrip?.type === 'BOARD' ? 'ALIGHT' : 'BOARD';
    }

    // Debounce: a duplicate same-type scan for this student+vehicle within the window
    // is an idempotent replay, not a new attendance record.
    const debounceSince = new Date(Date.now() - DEBOUNCE_SECONDS * 1000);
    const recentDuplicate = await BoardingEvent.findOne({
      studentId: student._id,
      vehicleId,
      type,
      timestamp: { $gte: debounceSince }
    }).sort({ timestamp: -1 });

    if (recentDuplicate) {
      return res.status(200).json({
        success: true,
        debounced: true,
        data: { ...eventPayload(recentDuplicate), studentName: student.fullName, riderCode: student.riderCode }
      });
    }

    const event = await BoardingEvent.create({
      studentId: student._id,
      vehicleId,
      routeId: vehicle.routeId,
      driverId: req.user._id,
      type,
      lat: validCoordinate(lat, -90, 90, 'lat'),
      lng: validCoordinate(lng, -180, 180, 'lng'),
      tripId,
      source: 'QR'
    });

    // Best-effort side effects — never fail the scan response over these.
    const io = req.app.get('io');
    if (io) {
      io.to(`route:${vehicle.routeId}`).emit('attendance:event', eventPayload(event));
      io.to(`student:${String(student._id)}`).emit('attendance:event', eventPayload(event));
    }

    try {
      const account = await User.findById(student.accountId).select('pushTokens');
      await sendBoardingPush(student, account, event, vehicle.vehicleName);
      await Notification.create({
        userId: student.accountId,
        studentId: student._id,
        type: 'BOARDING_EVENT',
        title: event.type === 'BOARD' ? 'Boarded shuttle' : 'Left shuttle',
        message: `${student.fullName} ${event.type === 'BOARD' ? 'boarded' : 'left'} ${vehicle.vehicleName || vehicle.vehicleId}.`,
        data: {
          studentId: String(student._id),
          vehicleId: vehicle.vehicleId,
          routeId: vehicle.routeId,
          relatedId: String(event._id)
        },
        priority: 'HIGH'
      });
    } catch (err) {
      console.error('Error dispatching boarding push:', err.message);
    }

    return res.status(201).json({
      success: true,
      debounced: false,
      data: { ...eventPayload(event), studentName: student.fullName, riderCode: student.riderCode }
    });
  } catch (error) {
    next(error);
  }
};
