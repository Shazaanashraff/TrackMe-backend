// Driver side of custom routes: report progress and upload recording rides.
// Mounted at /api/driver/custom-routes (protect + requireDriver).
// Manager side (review / confirm) lives in managerCustomRoutesController.js.

const Vehicle = require('../models/Vehicle');
const Route = require('../models/Route');
const RouteRecordingRun = require('../models/RouteRecordingRun');
const { haversineKm } = require('../utils/geo');
const {
  sanitizeRunInput,
  checkRunQuality,
  retryPendingMatches,
  refreshRouteProgress
} = require('../utils/customRoute');

// The driver's own custom route, or null. A driver is only ever allowed to touch
// the route of the vehicle assigned to them.
async function findDriverCustomRoute(driverId) {
  const vehicle = await Vehicle.findOne({ driverId, isDeleted: false });
  if (!vehicle || !vehicle.routeId) return { vehicle: vehicle || null, route: null };
  const route = await Route.findOne({ routeId: vehicle.routeId, origin: 'RECORDED', isDeleted: false });
  return { vehicle, route };
}

const routeSummary = (route) => ({
  routeId: route.routeId,
  status: route.status,
  requiredRuns: route.recording?.requiredRuns ?? 5,
  acceptedRuns: route.recording?.acceptedRuns ?? 0
});

const runSummary = (run) => ({
  id: String(run._id),
  clientRunId: run.clientRunId,
  runNumber: run.runNumber,
  status: run.status,
  rejectReason: run.rejectReason || '',
  distanceM: Math.round(run.distanceM || 0),
  startedAt: run.startedAt
});

// @desc    Progress of this driver's custom route ("ride 2 of 5")
// @route   GET /api/driver/custom-routes/current
// `data` is null for a driver whose vehicle is not on a custom route.
exports.getCurrent = async (req, res, next) => {
  try {
    const { route } = await findDriverCustomRoute(req.user._id);
    if (!route) return res.status(200).json({ success: true, data: null });

    // A ride saved while the matcher was down is re-tried whenever the app asks.
    let fresh = route;
    if (route.status === 'RECORDING') {
      const retried = await retryPendingMatches(route.routeId);
      if (retried > 0) fresh = (await refreshRouteProgress(route.routeId)) || route;
    }

    const runs = await RouteRecordingRun.find({
      routeId: fresh.routeId,
      status: { $in: ['ACCEPTED', 'PENDING_MATCH'] }
    }).select('-points -stops -matched').sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      data: { ...routeSummary(fresh), runs: runs.map(runSummary) }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Upload one recording ride
// @route   POST /api/driver/custom-routes/runs
// Idempotent on `clientRunId`: re-sending the same ride returns the same answer.
exports.submitRun = async (req, res, next) => {
  try {
    const clientRunId = String(req.body?.clientRunId || '').trim();
    if (!clientRunId || clientRunId.length > 100) {
      return res.status(400).json({ success: false, message: 'clientRunId is required' });
    }

    const { vehicle, route } = await findDriverCustomRoute(req.user._id);
    if (!route) {
      return res.status(404).json({ success: false, message: 'Your vehicle is not on a custom route' });
    }
    if (route.status !== 'RECORDING') {
      return res.status(409).json({
        success: false,
        code: 'NOT_RECORDING',
        message: 'This route is not collecting rides right now'
      });
    }

    const existing = await RouteRecordingRun.findOne({ routeId: route.routeId, clientRunId });
    if (existing) {
      return res.status(200).json({ success: true, data: { run: runSummary(existing), route: routeSummary(route) } });
    }

    const { points, stops } = sanitizeRunInput(req.body);
    const startedAt = req.body.startedAt ? new Date(req.body.startedAt) : null;
    const endedAt = req.body.endedAt ? new Date(req.body.endedAt) : null;
    const validDates = startedAt && endedAt && !Number.isNaN(startedAt) && !Number.isNaN(endedAt);
    const durationSec = validDates ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : 0;

    let distanceM = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      distanceM += haversineKm(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng) * 1000;
    }

    const base = {
      routeId: route.routeId,
      vehicleId: vehicle._id,
      driverId: req.user._id,
      managerId: route.managerId || null,
      clientRunId,
      startedAt: validDates ? startedAt : null,
      endedAt: validDates ? endedAt : null,
      durationSec,
      distanceM
    };

    const rejectReason = points.length === 0
      ? 'TOO_FEW_POINTS'
      : await checkRunQuality(route.routeId, points);

    let run;
    try {
      run = await RouteRecordingRun.create(
        rejectReason
          // A rejected ride keeps no track: it will never be used.
          ? { ...base, status: 'REJECTED', rejectReason, points: [], stops: [] }
          : { ...base, status: 'PENDING_MATCH', points, stops }
      );
    } catch (error) {
      if (error?.code === 11000) {
        const duplicate = await RouteRecordingRun.findOne({ routeId: route.routeId, clientRunId });
        return res.status(200).json({ success: true, data: { run: runSummary(duplicate), route: routeSummary(route) } });
      }
      throw error;
    }

    let freshRoute = route;
    if (run.status === 'PENDING_MATCH') {
      // One pass matches everything waiting - rides left over from an earlier outage
      // first, then this one - so numbering stays in ride order and the matcher is
      // called once per ride.
      await retryPendingMatches(route.routeId);
      run = (await RouteRecordingRun.findById(run._id)) || run;
      freshRoute = (await refreshRouteProgress(route.routeId)) || route;
    }

    return res.status(201).json({ success: true, data: { run: runSummary(run), route: routeSummary(freshRoute) } });
  } catch (error) {
    next(error);
  }
};

// @desc    Discard one of this driver's rides so it does not count
// @route   DELETE /api/driver/custom-routes/runs/:runId
exports.discardRun = async (req, res, next) => {
  try {
    const { route } = await findDriverCustomRoute(req.user._id);
    if (!route) {
      return res.status(404).json({ success: false, message: 'Your vehicle is not on a custom route' });
    }
    if (route.status !== 'RECORDING') {
      return res.status(409).json({ success: false, code: 'NOT_RECORDING', message: 'This route is not collecting rides right now' });
    }

    const run = await RouteRecordingRun.findOne({
      _id: req.params.runId,
      routeId: route.routeId,
      driverId: req.user._id
    });
    if (!run || run.status === 'DISCARDED') {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }

    run.status = 'DISCARDED';
    await run.save();

    // Close the gap so the remaining rides are numbered 1..n again.
    const remaining = await RouteRecordingRun.find({ routeId: route.routeId, status: 'ACCEPTED' }).sort({ runNumber: 1 });
    for (let i = 0; i < remaining.length; i += 1) {
      if (remaining[i].runNumber !== i + 1) {
        remaining[i].runNumber = i + 1;
        // eslint-disable-next-line no-await-in-loop
        await remaining[i].save();
      }
    }
    const fresh = (await refreshRouteProgress(route.routeId)) || route;

    return res.status(200).json({ success: true, data: { route: routeSummary(fresh) } });
  } catch (error) {
    next(error);
  }
};
