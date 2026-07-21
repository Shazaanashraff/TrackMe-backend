// Driver-facing QR scan endpoint — see docs/features/qr-attendance/QR_SYSTEM.md.
const Bus = require('../models/Bus');
const Route = require('../models/Route');
const BoardingEvent = require('../models/BoardingEvent');
const RouteMembership = require('../models/RouteMembership');
const User = require('../models/User');
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
    busId: event.busId,
    routeId: event.routeId,
    type: event.type,
    timestamp: event.timestamp,
    tripId: event.tripId,
    source: event.source
  };
}

// @desc    Driver scans a rider's QR to record a BOARD or ALIGHT event. Requires the
//          scanned bus's route to have QR attendance enabled by its manager.
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
      return res.status(401).json({ success: false, message: `Invalid QR token: ${verification.reason}` });
    }
    const { user: rider } = verification;

    const bus = await Bus.findOne({ busId, driverId: req.user._id, isDeleted: false });
    if (!bus) {
      return res.status(404).json({ success: false, message: 'Bus not found or not assigned to you' });
    }

    const route = await Route.findOne({ routeId: bus.routeId, isDeleted: false });
    if (!route?.qrEnabled) {
      return res.status(403).json({ success: false, message: 'QR attendance is not enabled for this route' });
    }

    const tripId = req.body?.tripId ? String(req.body.tripId) : dayTripId(busId);

    let type = typeof req.body?.type === 'string' ? req.body.type.toUpperCase() : null;
    if (type && !BoardingEvent.TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be BOARD or ALIGHT' });
    }
    if (!type) {
      const lastForTrip = await BoardingEvent.findOne({ studentId: rider._id, tripId })
        .sort({ timestamp: -1 });
      type = lastForTrip?.type === 'BOARD' ? 'ALIGHT' : 'BOARD';
    }

    // Debounce: a duplicate same-type scan for this student+bus within the window
    // is an idempotent replay, not a new attendance record.
    const debounceSince = new Date(Date.now() - DEBOUNCE_SECONDS * 1000);
    const recentDuplicate = await BoardingEvent.findOne({
      studentId: rider._id,
      busId,
      type,
      timestamp: { $gte: debounceSince }
    }).sort({ timestamp: -1 });

    if (recentDuplicate) {
      return res.status(200).json({ success: true, debounced: true, data: eventPayload(recentDuplicate) });
    }

    const event = await BoardingEvent.create({
      studentId: rider._id,
      busId,
      routeId: bus.routeId,
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
      io.to(`route:${bus.routeId}`).emit('attendance:event', eventPayload(event));
      io.to(`student:${String(rider._id)}`).emit('attendance:event', eventPayload(event));
    }

    try {
      await sendBoardingPush(rider, event, bus.busName);
    } catch (err) {
      console.error('Error dispatching boarding push:', err.message);
    }

    return res.status(201).json({ success: true, debounced: false, data: eventPayload(event) });
  } catch (error) {
    next(error);
  }
};

// Map a rider's latest trip event type to a roster status.
function statusFromLastType(lastType) {
  if (lastType === 'BOARD') return 'ON';
  if (lastType === 'ALIGHT') return 'OFF';
  return 'NOT_BOARDED';
}

// Sort order for the roster: on board first, then not-yet-boarded, then alighted; name as tiebreak.
const STATUS_ORDER = { ON: 0, NOT_BOARDED: 1, OFF: 2 };

// @desc    Roster for the driver's currently-assigned bus: who is enrolled on the route
//          and who is on board right now for the resolved trip. Powers the driver-app
//          "X / Y on board" card + roster page. Enrollment = ACTIVE RouteMembership on
//          the bus's route (so it is only meaningful on PRIVATE/shuttle routes; a PUBLIC
//          route with no memberships returns enrolledCount 0). "On board" is derived from
//          each rider's latest BoardingEvent within the trip window.
// @route   GET /api/driver/boarding/roster?busId=&tripId=
exports.getBoardingRoster = async (req, res, next) => {
  try {
    const busId = req.query?.busId ? String(req.query.busId) : '';
    if (!busId) {
      return res.status(400).json({ success: false, message: 'busId is required' });
    }

    const bus = await Bus.findOne({ busId, driverId: req.user._id, isDeleted: false });
    if (!bus) {
      return res.status(404).json({ success: false, message: 'Bus not found or not assigned to you' });
    }

    const route = await Route.findOne({ routeId: bus.routeId, isDeleted: false });
    if (!route?.qrEnabled) {
      return res.status(403).json({ success: false, message: 'QR attendance is not enabled for this route' });
    }

    const tripId = req.query?.tripId ? String(req.query.tripId) : dayTripId(busId);

    // Latest event per student within the trip → their current on-board status.
    const latestEvents = await BoardingEvent.aggregate([
      { $match: { tripId } },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$studentId',
          lastType: { $first: '$type' },
          lastEventAt: { $first: '$timestamp' }
        }
      }
    ]);
    const statusByStudent = new Map(
      latestEvents.map((e) => [String(e._id), { status: statusFromLastType(e.lastType), lastEventAt: e.lastEventAt }])
    );

    const memberships = await RouteMembership.find({ routeId: bus.routeId, status: 'ACTIVE' })
      .populate('userId', 'name')
      .lean();

    const enrolledIds = new Set();
    const roster = memberships.map((m) => {
      const studentId = String(m.userId?._id || m.userId);
      enrolledIds.add(studentId);
      const trip = statusByStudent.get(studentId);
      return {
        studentId,
        studentName: m.userId?.name || 'Unknown',
        status: trip?.status || 'NOT_BOARDED',
        lastEventAt: trip?.lastEventAt || null
      };
    });

    roster.sort((a, b) => {
      const order = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      return order !== 0 ? order : a.studentName.localeCompare(b.studentName);
    });

    const onBoardCount = roster.filter((r) => r.status === 'ON').length;

    // Riders currently on board who are not enrolled members (scanned a QR without a
    // membership). Surfaced separately so the headline onBoardCount / enrolledCount stays clean.
    const guestIds = latestEvents
      .filter((e) => e.lastType === 'BOARD' && !enrolledIds.has(String(e._id)))
      .map((e) => e._id);
    let guests = [];
    if (guestIds.length > 0) {
      const guestUsers = await User.find({ _id: { $in: guestIds } }).select('name').lean();
      const nameById = new Map(guestUsers.map((u) => [String(u._id), u.name]));
      guests = guestIds
        .map((id) => {
          const trip = statusByStudent.get(String(id));
          return {
            studentId: String(id),
            studentName: nameById.get(String(id)) || 'Unknown',
            lastEventAt: trip?.lastEventAt || null
          };
        })
        .sort((a, b) => a.studentName.localeCompare(b.studentName));
    }

    return res.status(200).json({
      success: true,
      data: {
        busId,
        routeId: bus.routeId,
        tripId,
        enrolledCount: roster.length,
        onBoardCount,
        roster,
        guests
      }
    });
  } catch (error) {
    next(error);
  }
};
