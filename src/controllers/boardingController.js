// Driver-facing QR scan endpoint — see docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md.
const Bus = require('../models/Bus');
const User = require('../models/User');
const BoardingEvent = require('../models/BoardingEvent');
const { verifyQr } = require('../utils/qrToken');
const { sendBoardingPush } = require('../utils/pushHelper');

// Debounce window: a repeat scan of the SAME type for the SAME student on the SAME
// bus within this many seconds is treated as a duplicate (idempotent replay, e.g.
// a driver double-tapping or an offline-queue resend) rather than a new event.
// Finalized default per todos/active/001-qr-attendance-foundation.md "Blocked" section.
const DEBOUNCE_SECONDS = Number(process.env.QR_SCAN_DEBOUNCE_SECONDS) || 30;

function dayTripId(busId, at = new Date()) {
  return `${busId}#${at.toISOString().slice(0, 10)}`;
}

function eventPayload(event) {
  return {
    eventId: String(event._id),
    studentId: String(event.studentId),
    membershipId: String(event.membershipId),
    busId: event.busId,
    routeId: event.routeId,
    type: event.type,
    timestamp: event.timestamp,
    tripId: event.tripId,
    source: event.source
  };
}

// @desc    Driver scans a rider's QR to record a BOARD or ALIGHT event
// @route   POST /api/driver/boarding/scan
// body: { token, busId, type?: 'BOARD'|'ALIGHT', lat?, lng?, tripId? }
// `type` explicit overrides toggle inference; omit it to auto-toggle off the
// rider's last event within the resolved trip window.
exports.scanBoarding = async (req, res, next) => {
  try {
    const { token, busId, lat, lng } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, message: 'token is required' });
    }
    if (!busId || typeof busId !== 'string') {
      return res.status(400).json({ success: false, message: 'busId is required' });
    }

    const verification = await verifyQr(token);
    if (!verification.valid) {
      const status = verification.reason === 'EXPIRED' ? 401 : 401;
      return res.status(status).json({ success: false, message: `Invalid QR token: ${verification.reason}` });
    }
    const { membership } = verification;

    const bus = await Bus.findOne({ busId, driverId: req.user._id, isDeleted: false });
    if (!bus) {
      return res.status(404).json({ success: false, message: 'Bus not found or not assigned to you' });
    }

    if (bus.routeId !== membership.routeId) {
      return res.status(403).json({ success: false, message: "Rider's membership does not match this bus's route" });
    }

    const tripId = req.body?.tripId ? String(req.body.tripId) : dayTripId(busId);

    let type = typeof req.body?.type === 'string' ? req.body.type.toUpperCase() : null;
    if (type && !BoardingEvent.TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be BOARD or ALIGHT' });
    }
    if (!type) {
      const lastForTrip = await BoardingEvent.findOne({ studentId: membership.userId, tripId })
        .sort({ timestamp: -1 });
      type = lastForTrip?.type === 'BOARD' ? 'ALIGHT' : 'BOARD';
    }

    // Debounce: a duplicate same-type scan for this student+bus within the window
    // is an idempotent replay, not a new attendance record.
    const debounceSince = new Date(Date.now() - DEBOUNCE_SECONDS * 1000);
    const recentDuplicate = await BoardingEvent.findOne({
      studentId: membership.userId,
      busId,
      type,
      timestamp: { $gte: debounceSince }
    }).sort({ timestamp: -1 });

    if (recentDuplicate) {
      return res.status(200).json({ success: true, debounced: true, data: eventPayload(recentDuplicate) });
    }

    const event = await BoardingEvent.create({
      studentId: membership.userId,
      membershipId: membership._id,
      busId,
      routeId: membership.routeId,
      driverId: req.user._id,
      type,
      lat: typeof lat === 'number' ? lat : null,
      lng: typeof lng === 'number' ? lng : null,
      tripId,
      source: 'QR'
    });

    // Best-effort side effects — never fail the scan response over these.
    const io = req.app.get('io');
    if (io) {
      io.to(`route:${membership.routeId}`).emit('attendance:event', eventPayload(event));
      io.to(`student:${String(membership.userId)}`).emit('attendance:event', eventPayload(event));
    }

    try {
      const rider = await User.findById(membership.userId);
      if (rider) await sendBoardingPush(rider, event, bus.busName);
    } catch (err) {
      console.error('Error dispatching boarding push:', err.message);
    }

    return res.status(201).json({ success: true, debounced: false, data: eventPayload(event) });
  } catch (error) {
    next(error);
  }
};
