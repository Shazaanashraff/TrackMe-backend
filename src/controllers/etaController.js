const Vehicle = require('../models/Vehicle');
const LiveLocation = require('../models/LiveLocation');
const Route = require('../models/Route');
const RouteMembership = require('../models/RouteMembership');

const getLat = (point) => point?.latitude ?? point?.lat;
const getLng = (point) => point?.longitude ?? point?.lng;
const getStopName = (stop) => stop?.name ?? stop?.stopName ?? 'Unknown Stop';

// Haversine formula to calculate distance between two coordinates (in km)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

// Calculate average speed from location history (in km/h)
const calculateAverageSpeed = (locations) => {
  if (locations.length < 2) return 30; // Default speed: 30 km/h
  
  let totalDistance = 0;
  let totalTime = 0;
  
  for (let i = 1; i < locations.length; i++) {
    const prev = locations[i - 1];
    const curr = locations[i];
    
    const distance = calculateDistance(
      prev.latitude,
      prev.longitude,
      curr.latitude,
      curr.longitude
    );
    
    const timeDiffMs = new Date(curr.timestamp) - new Date(prev.timestamp);
    const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
    
    totalDistance += distance;
    totalTime += timeDiffHours;
  }
  
  if (totalTime === 0) return 30;
  const avgSpeed = totalDistance / totalTime;
  
  // Sanity check: speed should be between 10-100 km/h for a vehicle
  return Math.max(10, Math.min(avgSpeed, 100));
};

// Get next stop in route based on current location
const getNextStop = (currentLat, currentLon, route, completedStops = []) => {
  if (!route.stops || route.stops.length === 0) return null;
  
  // Find next incomplete stop
  for (const stop of route.stops) {
    if (!completedStops.includes(stop._id.toString())) {
      return stop;
    }
  }
  
  return null; // All stops completed
};

const getVehicleLocationCandidates = (vehicle, fallbackVehicleId) => {
  const candidates = [
    fallbackVehicleId,
    vehicle?._id?.toString?.(),
    vehicle?.vehicleId
  ].filter(Boolean);

  return [...new Set(candidates)];
};

// Rider-facing ETA — resolves PUBLIC routes, or a PRIVATE route the caller has an
// ACTIVE membership on (Private Routes feature). All other PRIVATE routes (e.g. a
// manager's custom shuttle) stay invisible here.
// Returns { route: null, forbidden: false } when the route doesn't exist at all,
// or { route: null, forbidden: true } when it exists but the caller lacks access.
const findRouteByIdentifier = async (routeIdentifier, userId) => {
  const route =
    (await Route.findOne({ routeId: routeIdentifier, isDeleted: false }).lean()) ||
    (await Route.findOne({ _id: routeIdentifier, isDeleted: false }).lean());

  if (!route) return { route: null, forbidden: false };
  if (route.visibility === 'PUBLIC') return { route, forbidden: false };

  const isMember = userId && await RouteMembership.exists({ userId, routeId: route.routeId, status: 'ACTIVE' });
  return isMember ? { route, forbidden: false } : { route: null, forbidden: true };
};

/**
 * POST /api/eta/calculate
 * Calculate ETA for a specific vehicle
 */
const calculateVehicleETA = async (req, res) => {
  try {
    const { vehicleId, routeId } = req.body;
    
    if (!vehicleId || !routeId) {
      return res.status(400).json({ message: 'vehicleId and routeId required' });
    }
    
    const vehicle = (await Vehicle.findById(vehicleId).lean()) || (await Vehicle.findOne({ vehicleId }).lean());
    const locationCandidates = getVehicleLocationCandidates(vehicle, vehicleId);

    // Get current vehicle location
    const currentLocation = await LiveLocation.findOne({ vehicleId: { $in: locationCandidates } })
      .sort({ timestamp: -1 })
      .lean();
    
    if (!currentLocation) {
      return res.status(404).json({ message: 'Vehicle location not found' });
    }
    
    // Get route details
    const { route, forbidden } = await findRouteByIdentifier(routeId, req.user?._id);
    if (forbidden) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (!route) {
      return res.status(404).json({ message: 'Route not found' });
    }

    // Get vehicle details to check completed stops
    const completedStops = vehicle?.completedStops || [];
    
    // Get recent location history (last 30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentLocations = await LiveLocation.find({
      vehicleId: { $in: locationCandidates },
      timestamp: { $gte: thirtyMinutesAgo }
    })
      .sort({ timestamp: 1 })
      .lean();
    
    // Calculate average speed
    const avgSpeed = calculateAverageSpeed(recentLocations);
    
    // Get next stop
    const nextStop = getNextStop(
      getLat(currentLocation),
      getLng(currentLocation),
      route,
      completedStops
    );
    
    if (!nextStop) {
      return res.json({
        vehicleId,
        routeId,
        eta: null,
        status: 'completed',
        message: 'Vehicle has completed all stops on this route'
      });
    }
    
    // Calculate remaining distance to next stop
    const remainingDistance = calculateDistance(
      getLat(currentLocation),
      getLng(currentLocation),
      getLat(nextStop),
      getLng(nextStop)
    );
    
    // Calculate ETA: time = distance / speed (in hours)
    const timeToNextStopHours = remainingDistance / avgSpeed;
    const timeToNextStopMinutes = timeToNextStopHours * 60;
    
    // Calculate arrival time
    const etaTime = new Date(Date.now() + timeToNextStopMinutes * 60 * 1000);
    
    return res.json({
      vehicleId,
      routeId,
      currentLocation: {
        latitude: getLat(currentLocation),
        longitude: getLng(currentLocation)
      },
      nextStop: {
        id: nextStop._id,
        name: getStopName(nextStop),
        latitude: getLat(nextStop),
        longitude: getLng(nextStop)
      },
      eta: {
        time: etaTime,
        minutesRemaining: Math.round(timeToNextStopMinutes),
        distanceKm: Math.round(remainingDistance * 100) / 100
      },
      metrics: {
        averageSpeedKmh: Math.round(avgSpeed * 10) / 10,
        locationSampleSize: recentLocations.length
      }
    });
  } catch (error) {
    console.error('ETA calculation error:', error);
    res.status(500).json({ message: 'Failed to calculate ETA', error: error.message });
  }
};

/**
 * GET /api/eta/vehicle/:vehicleId/route/:routeId
 * Get ETA for a vehicle on a specific route
 */
const getVehicleETAByRoute = async (req, res) => {
  try {
    const { vehicleId, routeId } = req.params;
    
    if (!vehicleId || !routeId) {
      return res.status(400).json({ message: 'vehicleId and routeId required' });
    }
    
    // Call the calculate function with these parameters
    req.body = { vehicleId, routeId };
    return calculateVehicleETA(req, res);
  } catch (error) {
    console.error('Get ETA error:', error);
    res.status(500).json({ message: 'Failed to get ETA', error: error.message });
  }
};

/**
 * GET /api/eta/route/:routeId/all-vehicles
 * Get ETAs for all active vehicles on a route
 */
const getRouteETAs = async (req, res) => {
  try {
    const { routeId } = req.params;

    const { route, forbidden } = await findRouteByIdentifier(routeId, req.user?._id);
    if (forbidden) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (!route) {
      return res.status(404).json({ message: 'Route not found' });
    }

    // Get all active vehicles on this route
    const vehicles = await Vehicle.find({
      $or: [{ routeId }, { assignedRoute: routeId }],
      'isActive': true
    }).lean();
    
    if (vehicles.length === 0) {
      return res.json({ routeId, vehicles: [] });
    }
    
    // Calculate ETA for each vehicle
    const etasPromises = vehicles.map(async (vehicle) => {
      const locationCandidates = getVehicleLocationCandidates(vehicle, vehicle?._id?.toString?.());

      const currentLocation = await LiveLocation.findOne({ vehicleId: { $in: locationCandidates } })
        .sort({ timestamp: -1 })
        .lean();
        
      if (!currentLocation) return null;
      
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      const recentLocations = await LiveLocation.find({
        vehicleId: { $in: locationCandidates },
        timestamp: { $gte: thirtyMinutesAgo }
      })
        .sort({ timestamp: 1 })
        .lean();
      
      const avgSpeed = calculateAverageSpeed(recentLocations);
      const nextStop = getNextStop(
        getLat(currentLocation),
        getLng(currentLocation),
        route,
        vehicle.completedStops || []
      );
      
      if (!nextStop) return null;
      
      const remainingDistance = calculateDistance(
        getLat(currentLocation),
        getLng(currentLocation),
        getLat(nextStop),
        getLng(nextStop)
      );
      
      const timeToNextStopMinutes = (remainingDistance / avgSpeed) * 60;
      
      return {
        vehicleId: vehicle.vehicleId || vehicle._id,
        vehicleName: vehicle.vehicleName,
        eta: {
          time: new Date(Date.now() + timeToNextStopMinutes * 60 * 1000),
          minutesRemaining: Math.round(timeToNextStopMinutes)
        },
        nextStop: {
          name: getStopName(nextStop),
          id: nextStop._id
        }
      };
    });
    
    const etas = (await Promise.all(etasPromises)).filter(e => e !== null);
    
    return res.json({
      routeId,
      vehicles: etas,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Get route ETAs error:', error);
    res.status(500).json({ message: 'Failed to get route ETAs', error: error.message });
  }
};

module.exports = {
  calculateVehicleETA,
  getVehicleETAByRoute,
  getRouteETAs,
  calculateDistance,
  calculateAverageSpeed
};
