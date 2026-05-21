const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../src/models/User');
const Route = require('../src/models/Route');
const Bus = require('../src/models/Bus');

dotenv.config();

const MANAGER_EMAIL = 'testadmin@mail.com';
const MANAGER_DEFAULT_NAME = 'Test Admin Manager';
const MANAGER_DEFAULT_PASSWORD = 'TestAdmin@123';
const BUSES_PER_ROUTE = 3;

const ensureManager = async () => {
  const normalizedEmail = MANAGER_EMAIL.toLowerCase().trim();
  let manager = await User.findOne({ email: normalizedEmail });

  if (!manager) {
    manager = await User.create({
      name: MANAGER_DEFAULT_NAME,
      email: normalizedEmail,
      password: MANAGER_DEFAULT_PASSWORD,
      role: 'admin',
      isEmailVerified: true,
      isActive: true
    });
    console.log(`Created manager: ${normalizedEmail}`);
  } else {
    if (manager.role !== 'admin') {
      manager.role = 'admin';
    }
    if (!manager.isEmailVerified) {
      manager.isEmailVerified = true;
    }
    if (!manager.isActive) {
      manager.isActive = true;
    }
    await manager.save();
    console.log(`Using existing manager: ${normalizedEmail}`);
  }

  return manager;
};

const ensureDrivers = async (requiredCount) => {
  const drivers = [];

  for (let index = 1; index <= requiredCount; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const email = `route.driver.${suffix}@bus.com`;

    let driver = await User.findOne({ email });
    if (!driver) {
      driver = await User.create({
        name: `Route Driver ${suffix}`,
        email,
        password: 'Driver@123',
        role: 'driver',
        isEmailVerified: true,
        isActive: true
      });
    }

    drivers.push(driver);
  }

  return drivers;
};

const getRouteBusDefinition = (route, busSlot, driverId, managerId) => {
  const routeCode = String(route.routeId).toUpperCase();
  const slotCode = String(busSlot + 1);
  const busId = `SL-${routeCode}-${slotCode}`;
  const registrationNumber = `REG-SL-${routeCode}-${slotCode}-2026`;
  const numberPlate = `SL${routeCode}${slotCode}`;

  return {
    busId,
    busName: `${route.routeName} Bus ${slotCode}`,
    registrationNumber,
    numberPlate,
    routeId: route.routeId,
    driverId,
    managerId,
    seatCapacity: 45,
    busType: route.serviceType === 'OFFICE' ? 'DELUXE' : 'NON-AC',
    serviceType: route.serviceType || 'PUBLIC',
    bookingEnabled: true,
    isActive: false,
    maintenanceStatus: 'ACTIVE',
    isDeleted: false
  };
};

const seedManagerBusesPerRoute = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bus-tracking');
    console.log('Connected to MongoDB');

    const manager = await ensureManager();

    const routes = await Route.find({ isDeleted: false, isActive: true })
      .sort({ routeId: 1 })
      .lean();

    if (!routes.length) {
      console.log('No active routes found. Seed routes first.');
      await mongoose.connection.close();
      return;
    }

    const requiredDrivers = routes.length * BUSES_PER_ROUTE;
    const drivers = await ensureDrivers(requiredDrivers);

    const desiredBuses = [];
    routes.forEach((route, routeIndex) => {
      for (let busSlot = 0; busSlot < BUSES_PER_ROUTE; busSlot += 1) {
        const driver = drivers[routeIndex * BUSES_PER_ROUTE + busSlot];
        desiredBuses.push(
          getRouteBusDefinition(route, busSlot, driver._id, manager._id)
        );
      }
    });

    const usedRegistrations = new Set();
    const usedNumberPlates = new Set();

    for (const busDef of desiredBuses) {
      let counter = 0;
      let registrationNumber = busDef.registrationNumber;
      let numberPlate = busDef.numberPlate;

      while (
        usedRegistrations.has(registrationNumber) ||
        usedNumberPlates.has(numberPlate)
      ) {
        counter += 1;
        registrationNumber = `${busDef.registrationNumber}-${counter}`;
        numberPlate = `${busDef.numberPlate}${counter}`;
      }

      usedRegistrations.add(registrationNumber);
      usedNumberPlates.add(numberPlate);

      await Bus.findOneAndUpdate(
        { busId: busDef.busId },
        {
          $set: {
            ...busDef,
            registrationNumber,
            numberPlate
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const managedBusCount = await Bus.countDocuments({
      managerId: manager._id,
      isDeleted: false
    });

    console.log(`Seeded/updated ${desiredBuses.length} buses (${BUSES_PER_ROUTE} per route).`);
    console.log(`Manager ${MANAGER_EMAIL} now manages ${managedBusCount} buses.`);

    await mongoose.connection.close();
    console.log('Database connection closed');
  } catch (error) {
    console.error('Error seeding manager buses per route:', error.message);
    process.exit(1);
  }
};

seedManagerBusesPerRoute();
