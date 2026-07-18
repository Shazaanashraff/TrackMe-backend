const Bus = require('../models/Bus');
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
  
  // Sanity check: speed should be between 10-100 km/h for a bus
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

const getBusLocationCandidates = (bus, fallbackBusId) => {
  const candidates = [
    fallbackBusId,
    bus?._id?.toString?.(),
    bus?.busId
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
 * Calculate ETA for a specific bus
 */
const calculateBusETA = async (req, res) => {
  try {
    const { busId, routeId } = req.body;
    
    if (!busId || !routeId) {
      return res.status(400).json({ message: 'busId and routeId required' });
    }
    
    const bus = (await Bus.findById(busId).lean()) || (await Bus.findOne({ busId }).lean());
    const locationCandidates = getBusLocationCandidates(bus, busId);

    // Get current bus location
    const currentLocation = await LiveLocation.findOne({ busId: { $in: locationCandidates } })
      .sort({ timestamp: -1 })
      .lean();
    
    if (!currentLocation) {
      return res.status(404).json({ message: 'Bus location not found' });
    }
    
    // Get route details
    const { route, forbidden } = await findRouteByIdentifier(routeId, req.user?._id);
    if (forbidden) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (!route) {
      return res.status(404).json({ message: 'Route not found' });
    }

    // Get bus details to check completed stops
    const completedStops = bus?.completedStops || [];
    
    // Get recent location history (last 30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentLocations = await LiveLocation.find({
      busId: { $in: locationCandidates },
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
        busId,
        routeId,
        eta: null,
        status: 'completed',
        message: 'Bus has completed all stops on this route'
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
      busId,
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
 * GET /api/eta/bus/:busId/route/:routeId
 * Get ETA for a bus on a specific route
 */
const getBusETAByRoute = async (req, res) => {
  try {
    const { busId, routeId } = req.params;
    
    if (!busId || !routeId) {
      return res.status(400).json({ message: 'busId and routeId required' });
    }
    
    // Call the calculate function with these parameters
    req.body = { busId, routeId };
    return calculateBusETA(req, res);
  } catch (error) {
    console.error('Get ETA error:', error);
    res.status(500).json({ message: 'Failed to get ETA', error: error.message });
  }
};

/**
 * GET /api/eta/route/:routeId/all-buses
 * Get ETAs for all active buses on a route
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

    // Get all active buses on this route
    const buses = await Bus.find({
      $or: [{ routeId }, { assignedRoute: routeId }],
      'isActive': true
    }).lean();
    
    if (buses.length === 0) {
      return res.json({ routeId, buses: [] });
    }
    
    // Calculate ETA for each bus
    const etasPromises = buses.map(async (bus) => {
      const locationCandidates = getBusLocationCandidates(bus, bus?._id?.toString?.());

      const currentLocation = await LiveLocation.findOne({ busId: { $in: locationCandidates } })
        .sort({ timestamp: -1 })
        .lean();
        
      if (!currentLocation) return null;
      
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      const recentLocations = await LiveLocation.find({
        busId: { $in: locationCandidates },
        timestamp: { $gte: thirtyMinutesAgo }
      })
        .sort({ timestamp: 1 })
        .lean();
      
      const avgSpeed = calculateAverageSpeed(recentLocations);
      const nextStop = getNextStop(
        getLat(currentLocation),
        getLng(currentLocation),
        route,
        bus.completedStops || []
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
        busId: bus.busId || bus._id,
        busName: bus.busName,
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
      buses: etas,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Get route ETAs error:', error);
    res.status(500).json({ message: 'Failed to get route ETAs', error: error.message });
  }
};

module.exports = {
  calculateBusETA,
  getBusETAByRoute,
  getRouteETAs,
  calculateDistance,
  calculateAverageSpeed
};
