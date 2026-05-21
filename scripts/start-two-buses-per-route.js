const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../src/models/User');
const Route = require('../src/models/Route');
const Bus = require('../src/models/Bus');
const LiveLocation = require('../src/models/LiveLocation');

dotenv.config();

const MANAGER_EMAIL = 'testadmin@mail.com';
const ACTIVE_BUSES_PER_ROUTE = 2;

const toRad = (degrees) => (degrees * Math.PI) / 180;
const toDeg = (radians) => (radians * 180) / Math.PI;

const movePoint = (lat, lng, bearingDeg, distanceMeters) => {
  const earthRadius = 6371000;
  const bearing = toRad(bearingDeg);
  const latRad = toRad(lat);
  const lngRad = toRad(lng);
  const angularDistance = distanceMeters / earthRadius;

  const nextLat = Math.asin(
    Math.sin(latRad) * Math.cos(angularDistance) +
      Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  const nextLng =
    lngRad +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
      Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(nextLat)
    );

  return {
    lat: Number(toDeg(nextLat).toFixed(6)),
    lng: Number(toDeg(nextLng).toFixed(6))
  };
};

const getRouteStartPoint = (route) => {
  const orderedStops = [...(route.stops || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const firstStop = orderedStops[0];

  if (firstStop && Number.isFinite(firstStop.lat) && Number.isFinite(firstStop.lng)) {
    return {
      lat: Number(firstStop.lat),
      lng: Number(firstStop.lng)
    };
  }

  return null;
};

const startTwoBusesPerRoute = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bus-tracking');
    console.log('Connected to MongoDB');

    const manager = await User.findOne({ email: MANAGER_EMAIL.toLowerCase().trim(), role: 'admin' });
    if (!manager) {
      console.log(`Manager ${MANAGER_EMAIL} not found. Run seed-manager-buses-per-route first.`);
      await mongoose.connection.close();
      return;
    }

    const routes = await Route.find({ isDeleted: false, isActive: true })
      .sort({ routeId: 1 })
      .lean();

    let activatedTotal = 0;

    for (const route of routes) {
      const managerBuses = await Bus.find({
        routeId: route.routeId,
        managerId: manager._id,
        isDeleted: false
      })
        .sort({ busId: 1 })
        .lean();

      const allRouteBuses = await Bus.find({
        routeId: route.routeId,
        isDeleted: false
      })
        .sort({ busId: 1 })
        .lean();

      if (!managerBuses.length) {
        console.log(`Route ${route.routeId}: no manager-assigned buses found`);
        continue;
      }

      const busesToActivate = managerBuses.slice(0, ACTIVE_BUSES_PER_ROUTE);
      const activeBusIds = busesToActivate.map((bus) => bus.busId);

      await Bus.updateMany(
        {
          routeId: route.routeId,
          isDeleted: false,
          busId: { $in: activeBusIds }
        },
        { $set: { isActive: true } }
      );

      await Bus.updateMany(
        {
          routeId: route.routeId,
          isDeleted: false,
          busId: { $nin: activeBusIds }
        },
        { $set: { isActive: false } }
      );

      const inactiveRouteBusIds = allRouteBuses
        .map((bus) => bus.busId)
        .filter((busId) => !activeBusIds.includes(busId));

      if (inactiveRouteBusIds.length > 0) {
        await LiveLocation.deleteMany({
          routeId: route.routeId,
          busId: { $in: inactiveRouteBusIds }
        });
      }

      const routeStart = getRouteStartPoint(route);
      const locationDocs = [];

      busesToActivate.forEach((bus, index) => {
        let lat = routeStart?.lat;
        let lng = routeStart?.lng;

        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const shifted = movePoint(lat, lng, 40 + index * 35, 220 + index * 120);
          lat = shifted.lat;
          lng = shifted.lng;
        } else {
          lat = 6.927079 + index * 0.001;
          lng = 79.861244 + index * 0.001;
        }

        locationDocs.push({
          busId: bus.busId,
          routeId: route.routeId,
          lat,
          lng,
          accuracy: 8,
          speed: 28,
          timestamp: new Date()
        });
      });

      if (locationDocs.length > 0) {
        await LiveLocation.insertMany(locationDocs);
      }

      activatedTotal += activeBusIds.length;
      console.log(`Route ${route.routeId}: started ${activeBusIds.length} buses (${activeBusIds.join(', ')})`);
    }

    console.log(`Completed journey start simulation for ${activatedTotal} buses.`);
    await mongoose.connection.close();
    console.log('Database connection closed');
  } catch (error) {
    console.error('Error starting journey for buses:', error.message);
    process.exit(1);
  }
};

startTwoBusesPerRoute();
