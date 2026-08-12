const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Manager = require('../src/models/Manager');
const Driver = require('../src/models/Driver');
const Route = require('../src/models/Route');
const Vehicle = require('../src/models/Vehicle');

dotenv.config();

const MANAGER_EMAIL = 'testadmin@mail.com';
const MANAGER_DEFAULT_NAME = 'Test Admin Manager';
const MANAGER_DEFAULT_PASSWORD = 'TestAdmin@123';
// Vehicles created per route.
const VEHICLES_PER_ROUTE = Number(process.env.VEHICLES_PER_ROUTE || 8);

const ensureManager = async () => {
  const normalizedEmail = MANAGER_EMAIL.toLowerCase().trim();
  let manager = await Manager.findOne({ email: normalizedEmail });

  if (!manager) {
    manager = await Manager.create({
      name: MANAGER_DEFAULT_NAME,
      email: normalizedEmail,
      password: MANAGER_DEFAULT_PASSWORD,
      isEmailVerified: true,
      isActive: true
    });
    console.log(`Created manager: ${normalizedEmail}`);
  } else {
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
    const email = `route.driver.${suffix}@vehicle.com`;

    let driver = await Driver.findOne({ email });
    if (!driver) {
      driver = await Driver.create({
        name: `Route Driver ${suffix}`,
        email,
        password: 'Driver@123',
        isEmailVerified: true,
        isActive: true
      });
    }

    drivers.push(driver);
  }

  return drivers;
};

const getRouteVehicleDefinition = (route, vehicleSlot, driverId, managerId) => {
  const routeCode = String(route.routeId).toUpperCase();
  const slotCode = String(vehicleSlot + 1);
  const vehicleId = `SL-${routeCode}-${slotCode}`;
  const registrationNumber = `REG-SL-${routeCode}-${slotCode}-2026`;
  const numberPlate = `SL${routeCode}${slotCode}`;

  return {
    vehicleId,
    vehicleName: `${route.routeName} Vehicle ${slotCode}`,
    registrationNumber,
    numberPlate,
    routeId: route.routeId,
    driverId,
    managerId,
    seatCapacity: 45,
    vehicleType: route.serviceType === 'OFFICE' ? 'DELUXE' : 'NON-AC',
    serviceType: route.serviceType || 'PUBLIC',
    bookingEnabled: true,
    isActive: false,
    maintenanceStatus: 'ACTIVE',
    isDeleted: false
  };
};

const seedManagerVehiclesPerRoute = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vehicle-tracking');
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

    const requiredDrivers = routes.length * VEHICLES_PER_ROUTE;
    const drivers = await ensureDrivers(requiredDrivers);

    const desiredVehicles = [];
    routes.forEach((route, routeIndex) => {
      for (let vehicleSlot = 0; vehicleSlot < VEHICLES_PER_ROUTE; vehicleSlot += 1) {
        const driver = drivers[routeIndex * VEHICLES_PER_ROUTE + vehicleSlot];
        desiredVehicles.push(
          getRouteVehicleDefinition(route, vehicleSlot, driver._id, manager._id)
        );
      }
    });

    const usedRegistrations = new Set();
    const usedNumberPlates = new Set();

    for (const vehicleDef of desiredVehicles) {
      let counter = 0;
      let registrationNumber = vehicleDef.registrationNumber;
      let numberPlate = vehicleDef.numberPlate;

      while (
        usedRegistrations.has(registrationNumber) ||
        usedNumberPlates.has(numberPlate)
      ) {
        counter += 1;
        registrationNumber = `${vehicleDef.registrationNumber}-${counter}`;
        numberPlate = `${vehicleDef.numberPlate}${counter}`;
      }

      usedRegistrations.add(registrationNumber);
      usedNumberPlates.add(numberPlate);

      await Vehicle.findOneAndUpdate(
        { vehicleId: vehicleDef.vehicleId },
        {
          $set: {
            ...vehicleDef,
            registrationNumber,
            numberPlate
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const managedVehicleCount = await Vehicle.countDocuments({
      managerId: manager._id,
      isDeleted: false
    });

    console.log(`Seeded/updated ${desiredVehicles.length} vehicles (${VEHICLES_PER_ROUTE} per route).`);
    console.log(`Manager ${MANAGER_EMAIL} now manages ${managedVehicleCount} vehicles.`);

    await mongoose.connection.close();
    console.log('Database connection closed');
  } catch (error) {
    console.error('Error seeding manager vehicles per route:', error.message);
    process.exit(1);
  }
};

seedManagerVehiclesPerRoute();
