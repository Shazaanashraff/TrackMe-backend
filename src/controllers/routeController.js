const Route = require('../models/Route');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];

// @desc    Create a new route (admin only)
// @route   POST /api/routes
exports.createRoute = async (req, res, next) => {
  try {
    const { routeId, routeName, source, destination, distance, estimatedTime, fare, serviceType, stops, qrEnabled } = req.body;

    const normalizedStops = Array.isArray(stops)
      ? stops.map((stop, index) => ({
        stopName: stop.stopName,
        lat: stop.lat,
        lng: stop.lng,
        order: index + 1
      }))
      : [];

    // Check if route already exists
    const routeExists = await Route.findOne({ routeId, isDeleted: false });
    if (routeExists) {
      return res.status(400).json({ success: false, message: 'Route already exists' });
    }

    const route = await Route.create({
      routeId,
      routeName,
      source,
      destination,
      distance,
      estimatedTime: Number.isFinite(Number(estimatedTime)) ? Number(estimatedTime) : 0,
      fare,
      serviceType: serviceType || 'PUBLIC',
      stopsCount: normalizedStops.length,
      stops: normalizedStops,
      qrEnabled: !!qrEnabled,
      createdBy: req.user._id
    });

    res.status(201).json({
      success: true,
      message: 'Route created successfully',
      data: route
    });
  } catch (error) {
    next(error);
  }
};

// Every route is listable now that private routes are gone; geometry is still
// trimmed from list responses to keep them small.
const listableRouteFilter = () => ({});

const projectListedRoute = (route) => {
  const plain = route.toObject ? route.toObject() : route;
  const { stops, pathPolyline, pathPolylineReturn, ...rest } = plain;
  return rest;
};

// @desc    Get all routes
// @route   GET /api/routes
exports.getAllRoutes = async (req, res, next) => {
  try {
    const { isActive, serviceType } = req.query;
    // Unauthenticated endpoint (user-app search, public listings). Private-route
    // manager custom routes (and hidden Private Routes) must never surface here.
    const filter = { isDeleted: false, ...listableRouteFilter() };

    if (isActive === 'true') {
      filter.isActive = true;
    } else if (isActive === 'false') {
      filter.isActive = false;
    }

    if (serviceType && SERVICE_TYPES.includes(String(serviceType).toUpperCase())) {
      filter.serviceType = String(serviceType).toUpperCase();
    }

    const routes = await Route.find(filter)
      .select('routeId routeName source destination distance estimatedTime fare serviceType stopsCount isActive province createdBy createdAt');

    res.status(200).json({
      success: true,
      count: routes.length,
      data: routes.map(projectListedRoute)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single route by ID
// @route   GET /api/routes/:routeId
exports.getRouteById = async (req, res, next) => {
  try {
    const { routeId } = req.params;

    // Unauthenticated endpoint — never surface a manager's PRIVATE custom route.
    const route = await Route.findOne({ routeId, isDeleted: false });
    if (!route) {
      return res.status(404).json({ success: false, message: 'Route not found' });
    }

    res.status(200).json({
      success: true,
      data: route
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update a route (admin only)
// @route   PUT /api/routes/:routeId
exports.updateRoute = async (req, res, next) => {
  try {
    const { routeId } = req.params;
    const updateData = { ...req.body };

    if (Array.isArray(updateData.stops)) {
      updateData.stops = updateData.stops.map((stop, index) => ({
        stopName: stop.stopName,
        lat: stop.lat,
        lng: stop.lng,
        order: index + 1
      }));
      updateData.stopsCount = updateData.stops.length;
    }

    if (updateData.estimatedTime === undefined || updateData.estimatedTime === null || updateData.estimatedTime === '') {
      delete updateData.estimatedTime;
    }

    const route = await Route.findOneAndUpdate(
      { routeId, isDeleted: false },
      { ...updateData },
      { new: true, runValidators: true }
    );

    if (!route) {
      return res.status(404).json({ success: false, message: 'Route not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Route updated successfully',
      data: route
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Soft delete a route (admin only)
// @route   DELETE /api/routes/:routeId
exports.deleteRoute = async (req, res, next) => {
  try {
    const { routeId } = req.params;

    const route = await Route.findOneAndUpdate(
      { routeId, isDeleted: false },
      { isDeleted: true, isActive: false },
      { new: true }
    );

    if (!route) {
      return res.status(404).json({ success: false, message: 'Route not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Route deleted successfully',
      data: route
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get routes with pagination
// @route   GET /api/routes/list/paginated
exports.getRoutesPaginated = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Unauthenticated endpoint — never surface a hidden/custom PRIVATE route.
    const filter = { isDeleted: false, ...listableRouteFilter() };
    if (req.query.isActive) {
      filter.isActive = req.query.isActive === 'true';
    }
    if (req.query.serviceType && SERVICE_TYPES.includes(String(req.query.serviceType).toUpperCase())) {
      filter.serviceType = String(req.query.serviceType).toUpperCase();
    }

    const routes = await Route.find(filter)
      .select('-stops -pathPolyline -pathPolylineReturn')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const total = await Route.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: routes.map(projectListedRoute),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle route active status
// @route   PATCH /api/routes/:routeId/toggle
exports.toggleRouteStatus = async (req, res, next) => {
  try {
    const { routeId } = req.params;

    const route = await Route.findOne({ routeId, isDeleted: false });
    if (!route) {
      return res.status(404).json({ success: false, message: 'Route not found' });
    }

    route.isActive = !route.isActive;
    await route.save();

    res.status(200).json({
      success: true,
      message: `Route is now ${route.isActive ? 'active' : 'inactive'}`,
      data: route
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get routes statistics
// @route   GET /api/routes/stats/overview
exports.getRoutesStats = async (req, res, next) => {
  try {
    // Unauthenticated endpoint — stats only cover PUBLIC routes, never a manager's private ones.
    const [stats] = await Route.aggregate([
      { $match: { isDeleted: false } },
      {
        $facet: {
          total: [{ $count: 'count' }],
          active: [{ $match: { isActive: true } }, { $count: 'count' }],
          averages: [
            { $group: { _id: null, avgDistance: { $avg: '$distance' }, avgEstimatedTime: { $avg: '$estimatedTime' } } }
          ]
        }
      }
    ]);

    const totalRoutes = stats.total[0]?.count || 0;
    const activeRoutes = stats.active[0]?.count || 0;
    const inactiveRoutes = totalRoutes - activeRoutes;

    res.status(200).json({
      success: true,
      data: {
        totalRoutes,
        activeRoutes,
        inactiveRoutes,
        avgDistance: stats.averages[0]?.avgDistance || 0,
        avgEstimatedTime: stats.averages[0]?.avgEstimatedTime || 0
      }
    });
  } catch (error) {
    next(error);
  }
};
