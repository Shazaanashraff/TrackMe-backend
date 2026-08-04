const Vehicle = require('../models/Vehicle');
const Route = require('../models/Route');
const RouteChangeRequest = require('../models/RouteChangeRequest');
const { haversineKm, deviationStats } = require('../utils/geo');
const { downsample, snapToRoads, decodePolyline } = require('../utils/roadSnap');
const { createNotification } = require('../utils/notificationHelper');

const MIN_BREADCRUMB_POINTS = 2;
const MIN_TRIP_METERS = 50;

// Off-route detection thresholds (env-configurable; tune with real GPS data).
// A journey is flagged only when it's SUSTAINED off-route (both must be met),
// avoiding one-off GPS noise flagging false positives.
const THRESHOLD_METERS = Number(process.env.CUSTOM_ROUTE_THRESHOLD_METERS) || 150;
const THRESHOLD_FRACTION = Number(process.env.CUSTOM_ROUTE_THRESHOLD_FRACTION) || 0.35;

// A custom-route driver's vehicle always points at a provisional (or previously
// recorded) private route owned by their manager. Reject anything else so a
// driver can never record onto someone else's route.
async function getOwnedCustomRouteVehicle(req, res) {
  const vehicleId = String(req.body?.vehicleId || '').trim();
  if (!vehicleId) {
    res.status(400).json({ success: false, message: 'vehicleId is required' });
    return null;
  }

  const vehicle = await Vehicle.findOne({ vehicleId, driverId: req.user._id, isDeleted: false });
  if (!vehicle) {
    res.status(404).json({ success: false, message: 'Vehicle not found for this driver' });
    return null;
  }

  const route = await Route.findOne({ routeId: vehicle.routeId, isDeleted: false });
  if (!route || route.origin !== 'RECORDED' || String(route.managerId) !== String(vehicle.managerId)) {
    res.status(403).json({ success: false, message: 'This vehicle is not assigned a custom route' });
    return null;
  }

  return { vehicle, route };
}

function totalDistanceKm(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    total += haversineKm(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng);
  }
  return total;
}

// @desc    Submit a driver-recorded custom route (breadcrumb + stops)
// @route   POST /api/driver/custom-routes/record
exports.recordRoute = async (req, res, next) => {
  try {
    const owned = await getOwnedCustomRouteVehicle(req, res);
    if (!owned) return;
    const { vehicle, route } = owned;

    if (route.status !== 'PENDING_NAMING') {
      return res.status(409).json({
        success: false,
        message: 'This route has already been recorded and named. Use the update-route flow instead.'
      });
    }

    const breadcrumb = Array.isArray(req.body?.breadcrumb) ? req.body.breadcrumb : [];
    const rawStops = Array.isArray(req.body?.stops) ? req.body.stops : [];

    const validPoints = breadcrumb.filter(
      (p) => typeof p?.lat === 'number' && typeof p?.lng === 'number'
    );

    if (validPoints.length < MIN_BREADCRUMB_POINTS) {
      return res.status(400).json({ success: false, message: 'Recording is too short (need at least 2 GPS points)' });
    }

    const tripDistanceMeters = totalDistanceKm(validPoints) * 1000;
    if (tripDistanceMeters < MIN_TRIP_METERS) {
      return res.status(400).json({ success: false, message: 'Recorded distance is too short to be a real route' });
    }

    const downsampled = downsample(validPoints, 8);
    const { polyline, snapped } = await snapToRoads(downsampled);

    const stops = rawStops
      .filter((s) => typeof s?.lat === 'number' && typeof s?.lng === 'number')
      .map((s, i) => ({
        stopName: String(s.stopName || `Stop ${i + 1}`).trim(),
        order: i + 1,
        lat: s.lat,
        lng: s.lng
      }));

    route.pathPolyline = polyline;
    route.stops = stops;
    route.stopsCount = stops.length;
    route.distance = Math.round(totalDistanceKm(downsampled) * 100) / 100;
    route.recordedMeta = {
      recordedByDriverId: req.user._id,
      recordedByVehicleId: vehicle._id,
      recordedAt: new Date(),
      rawPointCount: validPoints.length,
      snapped
    };
    // status stays PENDING_NAMING: the manager still has to name it before it's usable elsewhere.
    await route.save();

    return res.status(200).json({
      success: true,
      message: 'Route sent to your manager for naming',
      data: {
        routeId: route.routeId,
        distance: route.distance,
        stopsCount: route.stopsCount,
        snapped,
        status: route.status
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get the driver's own custom-route status (for onboarding/UI branching)
// @route   GET /api/driver/custom-routes/my-route
exports.getMyCustomRoute = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findOne({ driverId: req.user._id, isDeleted: false });
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'No vehicle assigned to this driver' });
    }

    const route = await Route.findOne({ routeId: vehicle.routeId, isDeleted: false })
      .select('routeId routeName origin status distance stopsCount');

    if (!route || route.origin !== 'RECORDED') {
      return res.status(200).json({ success: true, data: { isCustomRoute: false } });
    }

    const pendingChangeRequest = await RouteChangeRequest.findOne({ vehicleId: vehicle._id, status: 'PENDING' })
      .select('_id');

    return res.status(200).json({
      success: true,
      data: {
        isCustomRoute: true,
        routeId: route.routeId,
        routeName: route.routeName,
        status: route.status,
        distance: route.distance,
        stopsCount: route.stopsCount,
        hasPendingChangeRequest: Boolean(pendingChangeRequest)
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Report a completed journey's breadcrumb for off-route detection.
//          If the driven path has drifted sustainedly from the saved route,
//          snaps the breadcrumb into a candidate and flags it to the manager.
// @route   POST /api/driver/custom-routes/:routeId/report-journey
exports.reportJourney = async (req, res, next) => {
  try {
    const owned = await getOwnedCustomRouteVehicle(req, res);
    if (!owned) return;
    const { vehicle, route } = owned;

    if (route.routeId !== req.params.routeId) {
      return res.status(403).json({ success: false, message: 'routeId does not match this vehicle\'s assigned route' });
    }
    if (route.status !== 'ACTIVE') {
      return res.status(409).json({ success: false, message: 'Route has not been named yet' });
    }

    const breadcrumb = Array.isArray(req.body?.breadcrumb) ? req.body.breadcrumb : [];
    const validPoints = breadcrumb.filter((p) => typeof p?.lat === 'number' && typeof p?.lng === 'number');
    if (validPoints.length < MIN_BREADCRUMB_POINTS) {
      return res.status(400).json({ success: false, message: 'Journey breadcrumb is too short to evaluate' });
    }

    const polylineCoords = decodePolyline(route.pathPolyline);
    const stats = deviationStats(validPoints, polylineCoords, THRESHOLD_METERS);

    const isFlagged = stats.fractionOff >= THRESHOLD_FRACTION && stats.maxMeters >= THRESHOLD_METERS;
    if (!isFlagged) {
      return res.status(200).json({ success: true, data: { flagged: false } });
    }

    // Dedupe: never spam the manager with more than one PENDING request per vehicle.
    const existing = await RouteChangeRequest.findOne({ vehicleId: vehicle._id, status: 'PENDING' });
    if (existing) {
      return res.status(200).json({ success: true, data: { flagged: true, changeRequestId: existing._id } });
    }

    const downsampled = downsample(validPoints, 8);
    const { polyline: candidatePolyline, snapped } = await snapToRoads(downsampled);
    const candidateDistance = Math.round(totalDistanceKm(downsampled) * 100) / 100;

    const changeRequest = await RouteChangeRequest.create({
      vehicleId: vehicle._id,
      managerId: vehicle.managerId,
      currentRouteId: route._id,
      candidate: { pathPolyline: candidatePolyline, stops: [], distance: candidateDistance, snapped },
      deviation: stats,
      status: 'PENDING'
    });

    await createNotification(
      vehicle.managerId,
      'ROUTE_UPDATE',
      `Possible route change: ${route.routeName}`,
      `${vehicle.vehicleName || vehicle.vehicleId} appears to have driven a different path than the saved route. Review the change request.`,
      { routeId: route.routeId, relatedId: changeRequest._id.toString(), priority: 'HIGH' }
    );

    return res.status(200).json({ success: true, data: { flagged: true, changeRequestId: changeRequest._id } });
  } catch (error) {
    next(error);
  }
};

// @desc    Driver manually re-records an ACTIVE custom route (e.g. after being
//          flagged, or proactively). Creates/updates a candidate for manager
//          review instead of overwriting the live route directly.
// @route   POST /api/driver/custom-routes/:routeId/record-update
exports.recordRouteUpdate = async (req, res, next) => {
  try {
    const owned = await getOwnedCustomRouteVehicle(req, res);
    if (!owned) return;
    const { vehicle, route } = owned;

    if (route.routeId !== req.params.routeId) {
      return res.status(403).json({ success: false, message: 'routeId does not match this vehicle\'s assigned route' });
    }
    if (route.status !== 'ACTIVE') {
      return res.status(409).json({ success: false, message: 'Route has not been named yet' });
    }

    const breadcrumb = Array.isArray(req.body?.breadcrumb) ? req.body.breadcrumb : [];
    const rawStops = Array.isArray(req.body?.stops) ? req.body.stops : [];
    const validPoints = breadcrumb.filter((p) => typeof p?.lat === 'number' && typeof p?.lng === 'number');

    if (validPoints.length < MIN_BREADCRUMB_POINTS) {
      return res.status(400).json({ success: false, message: 'Recording is too short (need at least 2 GPS points)' });
    }
    const tripDistanceMeters = totalDistanceKm(validPoints) * 1000;
    if (tripDistanceMeters < MIN_TRIP_METERS) {
      return res.status(400).json({ success: false, message: 'Recorded distance is too short to be a real route' });
    }

    const downsampled = downsample(validPoints, 8);
    const { polyline: candidatePolyline, snapped } = await snapToRoads(downsampled);
    const candidateDistance = Math.round(totalDistanceKm(downsampled) * 100) / 100;
    const stops = rawStops
      .filter((s) => typeof s?.lat === 'number' && typeof s?.lng === 'number')
      .map((s, i) => ({ stopName: String(s.stopName || `Stop ${i + 1}`).trim(), order: i + 1, lat: s.lat, lng: s.lng }));

    const polylineCoords = decodePolyline(route.pathPolyline);
    const stats = deviationStats(validPoints, polylineCoords, THRESHOLD_METERS);

    let changeRequest = await RouteChangeRequest.findOne({ vehicleId: vehicle._id, status: 'PENDING' });
    const isNew = !changeRequest;

    if (changeRequest) {
      changeRequest.candidate = { pathPolyline: candidatePolyline, stops, distance: candidateDistance, snapped };
      changeRequest.deviation = stats;
      await changeRequest.save();
    } else {
      changeRequest = await RouteChangeRequest.create({
        vehicleId: vehicle._id,
        managerId: vehicle.managerId,
        currentRouteId: route._id,
        candidate: { pathPolyline: candidatePolyline, stops, distance: candidateDistance, snapped },
        deviation: stats,
        status: 'PENDING'
      });
    }

    if (isNew) {
      await createNotification(
        vehicle.managerId,
        'ROUTE_UPDATE',
        `Driver submitted a route update: ${route.routeName}`,
        `${vehicle.vehicleName || vehicle.vehicleId} recorded a new version of this route for your review.`,
        { routeId: route.routeId, relatedId: changeRequest._id.toString(), priority: 'MEDIUM' }
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Route update sent to your manager for review',
      data: { changeRequestId: changeRequest._id }
    });
  } catch (error) {
    next(error);
  }
};
