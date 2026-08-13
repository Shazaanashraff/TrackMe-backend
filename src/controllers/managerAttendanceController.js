// Manager-facing attendance rollup — see docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md.
const BoardingEvent = require('../models/BoardingEvent');
const Route = require('../models/Route');
const RiderProfile = require('../models/RiderProfile');
const { resolveRange } = require('../utils/dateRange');

// @desc    Per-student attendance rollup + ranking across the manager's own routes
// @route   GET /api/manager/attendance?from&to[&routeId]
exports.getManagerAttendance = async (req, res, next) => {
  try {
    const managedRoutes = await Route.find({ managerId: req.user._id, isDeleted: false }).select('routeId');
    const managedRouteIds = managedRoutes.map((r) => r.routeId);

    let scopedRouteIds = managedRouteIds;
    if (req.query.routeId) {
      const requested = String(req.query.routeId).toUpperCase();
      if (!managedRouteIds.includes(requested)) {
        return res.status(403).json({ success: false, message: 'You do not manage this route' });
      }
      scopedRouteIds = [requested];
    }

    if (scopedRouteIds.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const { from, to } = resolveRange(req.query);
    const events = await BoardingEvent.find({
      routeId: { $in: scopedRouteIds },
      timestamp: { $gte: from, $lte: to }
    }).sort({ timestamp: 1 }).lean();

    const byStudent = new Map();
    for (const event of events) {
      const key = String(event.studentId);
      const entry = byStudent.get(key) || {
        studentId: key,
        boardCount: 0,
        alightCount: 0,
        lastEventAt: null,
        lastEventType: null
      };
      if (event.type === 'BOARD') entry.boardCount += 1;
      else entry.alightCount += 1;
      entry.lastEventAt = event.timestamp;
      entry.lastEventType = event.type;
      byStudent.set(key, entry);
    }

    const students = await RiderProfile.find({ _id: { $in: [...byStudent.keys()] } }).select('fullName riderCode').lean();
    const nameById = new Map(students.map((student) => [String(student._id), student.fullName]));

    const rollup = [...byStudent.values()]
      .map((entry) => ({ ...entry, studentName: nameById.get(entry.studentId) || 'Unknown' }))
      .sort((a, b) => (b.boardCount + b.alightCount) - (a.boardCount + a.alightCount));

    return res.status(200).json({
      success: true,
      data: rollup,
      range: { from: from.toISOString(), to: to.toISOString() }
    });
  } catch (error) {
    next(error);
  }
};
