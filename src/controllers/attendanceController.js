// Rider/manager-facing attendance read endpoints — see
// docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md.
const mongoose = require('mongoose');
const BoardingEvent = require('../models/BoardingEvent');
const RouteMembership = require('../models/RouteMembership');

const DEFAULT_RANGE_DAYS = 30;

function resolveRange(query) {
  const to = query?.to ? new Date(query.to) : new Date();
  const from = query?.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

function summarize(events) {
  const summary = { totalBoard: 0, totalAlight: 0, byRoute: {} };
  for (const event of events) {
    const bucket = summary.byRoute[event.routeId] || { board: 0, alight: 0 };
    if (event.type === 'BOARD') {
      summary.totalBoard += 1;
      bucket.board += 1;
    } else {
      summary.totalAlight += 1;
      bucket.alight += 1;
    }
    summary.byRoute[event.routeId] = bucket;
  }
  return summary;
}

// @desc    A student/rider's own boarding/alighting history + summary
// @route   GET /api/attendance/student/:studentId?from&to
// Authorized for the rider themselves, or a manager who manages a route this
// rider has (or had) membership on.
exports.getStudentAttendance = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ success: false, message: 'Invalid studentId' });
    }

    const isSelf = String(req.user._id) === String(studentId);
    const isManager = ['admin', 'super-admin'].includes(req.user.role);
    if (!isSelf) {
      if (!isManager) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      if (req.user.role === 'admin') {
        const managesRider = await RouteMembership.exists({ userId: studentId, managerId: req.user._id });
        if (!managesRider) {
          return res.status(403).json({ success: false, message: 'Access denied' });
        }
      }
    }

    const { from, to } = resolveRange(req.query);
    const events = await BoardingEvent.find({
      studentId,
      timestamp: { $gte: from, $lte: to }
    }).sort({ timestamp: 1 }).lean();

    return res.status(200).json({
      success: true,
      data: {
        events,
        summary: summarize(events),
        range: { from: from.toISOString(), to: to.toISOString() }
      }
    });
  } catch (error) {
    next(error);
  }
};
