// Manager side of custom routes: see recording progress, review the route built from
// the driver's rides, and confirm it. Mounted under /api/manager (requireManager).
// Every query is scoped to the calling manager; another manager's route is a 404.

const Route = require('../models/Route');
const Vehicle = require('../models/Vehicle');
const Driver = require('../models/Driver');
const RouteRecordingRun = require('../models/RouteRecordingRun');
const { writeAuditLog } = require('../utils/managerAudit');
const { invalidatePathCache, requiredRuns } = require('../utils/customRoute');

const STATUSES = ['RECORDING', 'PENDING_REVIEW', 'ACTIVE'];
const MAX_EXTRA_RUNS = 3;
const MAX_STOPS = 100;

const own = (managerId, routeId) => ({ routeId, managerId, origin: 'RECORDED', isDeleted: false });

const listItem = (route, vehicle, driver) => ({
  routeId: route.routeId,
  routeName: route.routeName,
  status: route.status,
  distance: route.distance,
  stopsCount: route.stopsCount,
  requiredRuns: route.recording?.requiredRuns ?? 5,
  acceptedRuns: route.recording?.acceptedRuns ?? 0,
  confidence: route.recording?.confidence ?? null,
  warning: route.recording?.warning || '',
  builtAt: route.recording?.builtAt || null,
  hasLiveLine: Boolean(route.pathPolyline),
  vehicle: vehicle ? { vehicleId: vehicle.vehicleId, vehicleName: vehicle.vehicleName } : null,
  driver: driver ? { name: driver.name } : null,
  createdAt: route.createdAt
});

async function vehiclesAndDrivers(managerId, routeIds) {
  const vehicles = await Vehicle.find({ managerId, routeId: { $in: routeIds }, isDeleted: false })
    .select('vehicleId vehicleName routeId driverId');
  const drivers = await Driver.find({ _id: { $in: vehicles.map((v) => v.driverId).filter(Boolean) } }).select('name');
  const driverById = new Map(drivers.map((d) => [String(d._id), d]));
  return { vehicles, driverById };
}

// @desc    The manager's custom routes with recording progress
// @route   GET /api/manager/custom-routes?status=
exports.listCustomRoutes = async (req, res, next) => {
  try {
    const filter = { managerId: req.user._id, origin: 'RECORDED', isDeleted: false };
    if (req.query.status) {
      const status = String(req.query.status).toUpperCase();
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
      }
      filter.status = status;
    }

    const routes = await Route.find(filter)
      .select('-pathPolyline -pathPolylineReturn -stops -recording.candidate')
      .sort({ createdAt: -1 });
    const { vehicles, driverById } = await vehiclesAndDrivers(req.user._id, routes.map((r) => r.routeId));
    const vehicleByRoute = new Map(vehicles.map((v) => [v.routeId, v]));

    const data = routes.map((route) => {
      const vehicle = vehicleByRoute.get(route.routeId);
      return listItem(route, vehicle, vehicle ? driverById.get(String(vehicle.driverId)) : null);
    });
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
};

// @desc    How many custom routes are waiting for this manager to confirm
// @route   GET /api/manager/custom-routes/count
exports.countPendingReview = async (req, res, next) => {
  try {
    const pendingReview = await Route.countDocuments({
      managerId: req.user._id, origin: 'RECORDED', isDeleted: false, status: 'PENDING_REVIEW'
    });
    return res.status(200).json({ success: true, data: { pendingReview } });
  } catch (error) {
    next(error);
  }
};

// @desc    One custom route with its line, stops and every accepted ride (for the review map)
// @route   GET /api/manager/custom-routes/:routeId
exports.getCustomRoute = async (req, res, next) => {
  try {
    const route = await Route.findOne(own(req.user._id, req.params.routeId));
    if (!route) return res.status(404).json({ success: false, message: 'Custom route not found' });

    const runs = await RouteRecordingRun.find({ routeId: route.routeId, status: 'ACCEPTED' })
      .select('runNumber distanceM durationSec startedAt matched.polyline matched.confidence')
      .sort({ runNumber: 1 });
    const { vehicles, driverById } = await vehiclesAndDrivers(req.user._id, [route.routeId]);
    const vehicle = vehicles[0] || null;

    const candidate = route.recording?.candidate;
    const hasCandidate = Boolean(candidate && candidate.pathPolyline);
    // While a re-recording awaits confirmation, review the new line, not the live one.
    const shown = hasCandidate
      ? { pathPolyline: candidate.pathPolyline, stops: candidate.stops, distance: candidate.distance, estimatedTime: candidate.estimatedTime }
      : { pathPolyline: route.pathPolyline, stops: route.stops, distance: route.distance, estimatedTime: route.estimatedTime };

    return res.status(200).json({
      success: true,
      data: {
        ...listItem(route, vehicle, vehicle ? driverById.get(String(vehicle.driverId)) : null),
        source: route.source,
        destination: route.destination,
        fare: route.fare,
        estimatedTime: shown.estimatedTime,
        pathPolyline: shown.pathPolyline,
        stops: (shown.stops || []).map((s) => ({ stopName: s.stopName, order: s.order, lat: s.lat, lng: s.lng })),
        isReRecording: hasCandidate || (route.status !== 'ACTIVE' && Boolean(route.pathPolyline)),
        livePathPolyline: hasCandidate ? route.pathPolyline : '',
        runs: runs.map((r) => ({
          runNumber: r.runNumber,
          distanceM: Math.round(r.distanceM || 0),
          durationSec: r.durationSec,
          startedAt: r.startedAt,
          pathPolyline: r.matched?.polyline || ''
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

const cleanStops = (input) => {
  if (!Array.isArray(input)) return null;
  const stops = input.slice(0, MAX_STOPS)
    .filter((s) => Number.isFinite(Number(s?.lat)) && Number.isFinite(Number(s?.lng))
      && Math.abs(Number(s.lat)) <= 90 && Math.abs(Number(s.lng)) <= 180)
    .map((s, i) => ({
      stopName: String(s.stopName || '').trim().slice(0, 80) || `Stop ${i + 1}`,
      order: i + 1,
      lat: Number(s.lat),
      lng: Number(s.lng)
    }));
  return stops;
};

// @desc    Confirm a built route: name it and put it live
// @route   PATCH /api/manager/custom-routes/:routeId/confirm
exports.confirmCustomRoute = async (req, res, next) => {
  try {
    const routeName = String(req.body?.routeName || '').trim();
    if (!routeName) return res.status(400).json({ success: false, message: 'Route name is required' });
    if (routeName.length > 120) return res.status(400).json({ success: false, message: 'Route name is too long' });

    const fareRaw = req.body?.fare;
    if (fareRaw !== undefined && fareRaw !== null && fareRaw !== '' && !(Number(fareRaw) >= 0)) {
      return res.status(400).json({ success: false, message: 'Fare must be a number, 0 or more' });
    }

    const route = await Route.findOne(own(req.user._id, req.params.routeId));
    if (!route) return res.status(404).json({ success: false, message: 'Custom route not found' });
    if (route.status !== 'PENDING_REVIEW') {
      return res.status(409).json({
        success: false,
        code: 'NOT_PENDING_REVIEW',
        message: route.status === 'ACTIVE' ? 'This route is already confirmed' : 'This route is still collecting rides'
      });
    }

    const candidate = route.recording?.candidate;
    const useCandidate = Boolean(candidate && candidate.pathPolyline);
    const baseStops = useCandidate ? candidate.stops : route.stops;
    const stops = cleanStops(req.body?.stops) || baseStops.map((s) => ({
      stopName: s.stopName, order: s.order, lat: s.lat, lng: s.lng
    }));

    const set = {
      routeName,
      source: String(req.body?.source || '').trim() || stops[0]?.stopName || 'Start',
      destination: String(req.body?.destination || '').trim() || stops[stops.length - 1]?.stopName || 'End',
      stops,
      stopsCount: stops.length,
      status: 'ACTIVE',
      isActive: true,
      'recording.candidate': { pathPolyline: '', stops: [], distance: 0, estimatedTime: 0 }
    };
    if (fareRaw !== undefined && fareRaw !== null && fareRaw !== '') set.fare = Number(fareRaw);
    if (useCandidate) {
      set.pathPolyline = candidate.pathPolyline;
      set.distance = candidate.distance;
      set.estimatedTime = candidate.estimatedTime;
    }

    // The status condition makes a double confirm (two tabs) a clean no-op.
    const updated = await Route.findOneAndUpdate(
      { ...own(req.user._id, route.routeId), status: 'PENDING_REVIEW' },
      { $set: set },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ success: false, code: 'NOT_PENDING_REVIEW', message: 'This route is already confirmed' });
    }

    invalidatePathCache(updated.routeId);
    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'CUSTOM_ROUTE_CONFIRMED',
      entityType: 'ROUTE',
      entityId: updated.routeId,
      metadata: { routeName, confidence: updated.recording?.confidence ?? null }
    });

    return res.status(200).json({ success: true, message: 'Route confirmed', data: listItem(updated, null, null) });
  } catch (error) {
    next(error);
  }
};

// @desc    Ask the driver for more rides before confirming
// @route   POST /api/manager/custom-routes/:routeId/record-more
exports.recordMore = async (req, res, next) => {
  try {
    const extra = Number(req.body?.extraRuns);
    if (!Number.isInteger(extra) || extra < 1 || extra > MAX_EXTRA_RUNS) {
      return res.status(400).json({ success: false, message: `extraRuns must be a whole number from 1 to ${MAX_EXTRA_RUNS}` });
    }

    const updated = await Route.findOneAndUpdate(
      { ...own(req.user._id, req.params.routeId), status: 'PENDING_REVIEW' },
      { $set: { status: 'RECORDING' }, $inc: { 'recording.requiredRuns': extra } },
      { new: true }
    );
    if (!updated) {
      const exists = await Route.exists(own(req.user._id, req.params.routeId));
      return exists
        ? res.status(409).json({ success: false, code: 'NOT_PENDING_REVIEW', message: 'Only a route awaiting review can ask for more rides' })
        : res.status(404).json({ success: false, message: 'Custom route not found' });
    }
    return res.status(200).json({ success: true, data: listItem(updated, null, null) });
  } catch (error) {
    next(error);
  }
};

// @desc    Start recording a confirmed route again (the live line stays until the new one is confirmed)
// @route   POST /api/manager/custom-routes/:routeId/rerecord
exports.reRecord = async (req, res, next) => {
  try {
    const updated = await Route.findOneAndUpdate(
      { ...own(req.user._id, req.params.routeId), status: 'ACTIVE' },
      {
        $set: {
          status: 'RECORDING',
          'recording.requiredRuns': requiredRuns(),
          'recording.acceptedRuns': 0,
          'recording.confidence': null,
          'recording.warning': '',
          'recording.candidate': { pathPolyline: '', stops: [], distance: 0, estimatedTime: 0 }
        }
      },
      { new: true }
    );
    if (!updated) {
      const exists = await Route.exists(own(req.user._id, req.params.routeId));
      return exists
        ? res.status(409).json({ success: false, code: 'NOT_ACTIVE', message: 'Only a confirmed route can be re-recorded' })
        : res.status(404).json({ success: false, message: 'Custom route not found' });
    }

    // The old rides belong to the old recording.
    await RouteRecordingRun.updateMany(
      { routeId: updated.routeId, status: { $in: ['ACCEPTED', 'PENDING_MATCH'] } },
      { $set: { status: 'DISCARDED' } }
    );

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'CUSTOM_ROUTE_RERECORD_STARTED',
      entityType: 'ROUTE',
      entityId: updated.routeId,
      metadata: {}
    });
    return res.status(200).json({ success: true, data: listItem(updated, null, null) });
  } catch (error) {
    next(error);
  }
};
