// Rider/manager-facing attendance read endpoints — see
// docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md.
const mongoose = require('mongoose');
const BoardingEvent = require('../models/BoardingEvent');
const Vehicle = require('../models/Vehicle');
const User = require('../models/User');
const { resolveRange } = require('../utils/dateRange');

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
// Authorized for the rider themselves, anyone sharing their identity (the
// account holder reading a managed child's history, or vice versa), or a
// manager who manages a route this rider has (or had) membership on.
exports.getStudentAttendance = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ success: false, message: 'Invalid studentId' });
    }

    const isSelf = String(req.user._id) === String(studentId);
    const isManager = ['admin', 'super-admin'].includes(req.user.role);

    if (!isSelf) {
      // `Boolean(req.identityId) &&` first: a pre-migration caller with no
      // identityId must never match a target that also has none — same
      // discipline as requireOwnProfile in middleware/auth.js. Without it,
      // two identity-less accounts would read as the same household purely
      // because `undefined === undefined`.
      const isSameHousehold = Boolean(req.identityId)
        && await User.exists({ _id: studentId, identityId: req.identityId });

      if (!isSameHousehold) {
        if (!isManager) {
          return res.status(403).json({ success: false, message: 'Access denied' });
        }
        if (req.user.role === 'admin') {
          // Route membership is gone, so a manager's authority over a rider is
          // derived from the fleet instead: they may read this rider's attendance
          // only if the rider has actually boarded one of their vehicles.
          const managedVehicleIds = await Vehicle.find({
            managerId: req.user._id,
            isDeleted: false
          }).distinct('_id');

          const managesRider = await BoardingEvent.exists({
            studentId,
            vehicleId: { $in: managedVehicleIds }
          });

          if (!managesRider) {
            return res.status(403).json({ success: false, message: 'Access denied' });
          }
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
