#!/usr/bin/env node
// Wipes and re-seeds the SANDBOX database with fixtures for Developer Mode's manual
// CRUD testing. See docs/modules/SANDBOX.md and DEVELOPER_MODE_PLAN.md work item 2.
//
// This script wipes collections, so it is guarded to be structurally incapable of
// running against dev or prod: it refuses unless the connected database's name
// contains "sandbox", whatever env file happens to be loaded. Do not weaken this.
//
// Goes through createIdentityWithProfile for every identity-linked account (managers,
// the super admin, the rider), same as the rest of the identity model — see
// backend/CLAUDE.md's "Running" section for why the old seed scripts (which wrote
// Manager/Driver docs directly) were deleted. Drivers are the one exception: they sign
// in with a driver code and have no Identity at all (see src/models/Driver.js), so
// they're created directly via Driver.create, same as managerDriversController does.

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.sandbox') });

const mongoose = require('mongoose');
const Identity = require('../src/models/Identity');
const SuperAdmin = require('../src/models/SuperAdmin');
const Manager = require('../src/models/Manager');
const Driver = require('../src/models/Driver');
const User = require('../src/models/User');
const Vehicle = require('../src/models/Vehicle');
const Route = require('../src/models/Route');
const Booking = require('../src/models/Booking');
const ManagerVehicleRequest = require('../src/models/ManagerVehicleRequest');
const RiderProfile = require('../src/models/RiderProfile');
const DriverEnrollment = require('../src/models/DriverEnrollment');
const VehicleLiveLocation = require('../src/models/VehicleLiveLocation');
const Notification = require('../src/models/Notification');
const RouteRecordingRun = require('../src/models/RouteRecordingRun');
const HouseholdPlace = require('../src/models/HouseholdPlace');
const { encodePolyline } = require('../src/utils/roadSnap');
const { createIdentityWithProfile } = require('../src/utils/identityRegistry');
const { graceMs } = require('../src/services/accountDeletion');
const { generateUniqueDriverCode } = require('../src/utils/driverCode');
const { generateUniqueRiderCode } = require('../src/utils/riderCode');

const SANDBOX_PASSWORD = 'sandbox-password-change-me';

function dbNameFromUri(uri) {
  const withoutQuery = uri.split('?')[0];
  const afterScheme = withoutQuery.split('//')[1] || '';
  return afterScheme.split('/')[1] || '';
}

async function assertSandboxDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set — copy .env.sandbox.example to .env.sandbox first.');
    process.exit(1);
  }

  const dbName = dbNameFromUri(uri);
  if (!dbName.toLowerCase().includes('sandbox')) {
    console.error(
      `Refusing to seed: database "${dbName}" does not contain "sandbox". ` +
      'seed-sandbox.js wipes collections and must never run against dev or prod — check MONGODB_URI.'
    );
    process.exit(1);
  }

  return { uri, dbName };
}

async function wipeCollections() {
  await Promise.all([
    Identity.deleteMany({}),
    SuperAdmin.deleteMany({}),
    Manager.deleteMany({}),
    Driver.deleteMany({}),
    User.deleteMany({}),
    Vehicle.deleteMany({}),
    Route.deleteMany({}),
    Booking.deleteMany({}),
    ManagerVehicleRequest.deleteMany({}),
    RiderProfile.deleteMany({}),
    DriverEnrollment.deleteMany({}),
    VehicleLiveLocation.deleteMany({}),
    Notification.deleteMany({ recipientRole: 'manager' }),
    RouteRecordingRun.deleteMany({}),
    HouseholdPlace.deleteMany({}),
    Notification.deleteMany({ type: 'VEHICLE_ARRIVAL' }),
  ]);
}

// Mirrors the dev database's superadmin _id so a JWT issued by the dev backend also
// authenticates against the sandbox backend — `protect` resolves by profile _id (see
// middleware/auth.js), not by email. Must run before the sandbox server's first boot:
// ensureSuperAdminAccount no-ops once a SuperAdmin document exists, so seeding first is
// what stops it minting a second, random-id superadmin that would break the shared token.
async function seedSuperAdmin() {
  const mirrorId = process.env.SANDBOX_MIRROR_SUPERADMIN_ID;
  if (!mirrorId) {
    console.error(
      'SANDBOX_MIRROR_SUPERADMIN_ID is not set in .env.sandbox — see the comment above it ' +
      'in .env.sandbox.example for how to find your dev superadmin\'s _id.'
    );
    process.exit(1);
  }

  const email = process.env.SUPERADMIN_EMAIL || 'superadmin@trackme.dev';
  const password = process.env.SUPERADMIN_PASSWORD || SANDBOX_PASSWORD;

  await createIdentityWithProfile({
    email,
    password,
    isEmailVerified: true,
    isProvisional: false,
    role: 'super-admin',
    fields: {
      _id: new mongoose.Types.ObjectId(mirrorId),
      name: 'Sandbox Super Admin',
      isActive: true,
      isEmailVerified: true,
    },
  });

  return mirrorId;
}

async function seedManagers() {
  const fixtures = [
    { email: 'manager.colombo@trackme.dev', name: 'Colombo Manager', province: 'Western' },
    { email: 'manager.kandy@trackme.dev', name: 'Kandy Manager', province: 'Central' },
  ];

  const managers = [];
  for (const fixture of fixtures) {
    const { doc } = await createIdentityWithProfile({
      email: fixture.email,
      password: SANDBOX_PASSWORD,
      isEmailVerified: true,
      role: 'admin',
      fields: {
        name: fixture.name,
        province: fixture.province,
        isActive: true,
        isEmailVerified: true,
      },
    });
    managers.push(doc);
  }
  return managers;
}

// A driver belongs to exactly one manager (Driver.managerId), and every
// manager-facing query scopes by it: the driver directory, the enrolment queue
// and the enrolled roster all resolve through the drivers a manager owns. Seeded
// with managerId null, the whole manager portal renders empty, so the fixtures
// alternate between the two managers. One of them is deliberately `isPrivate`,
// which is what decides whether redeeming their key queues a request (PENDING)
// or enrols outright (ACTIVE) — both states need to exist to be seen.
async function seedDrivers(managers) {
  const fixtures = [
    { name: 'Driver One', isPrivate: false },
    { name: 'Driver Two', isPrivate: true },
    { name: 'Driver Three', isPrivate: true },
    { name: 'Driver Four', isPrivate: false },
  ];

  const drivers = [];
  for (const [index, fixture] of fixtures.entries()) {
    // No Identity: a driver's permanent, human-readable driverCode is its real sign-in
    // credential (see src/models/Driver.js), same as managerDriversController.createManagerDriver.
    const driver = await Driver.create({
      name: fixture.name,
      driverCode: await generateUniqueDriverCode(Driver),
      password: SANDBOX_PASSWORD,
      phoneNumber: '0770000000',
      isActive: true,
      isPrivate: fixture.isPrivate,
      managerId: managers[index % managers.length]._id,
    });
    drivers.push(driver);
  }
  return drivers;
}

async function seedRoutes() {
  const fixtures = [
    { routeId: 'SANDBOX-R1', routeName: 'Colombo - Kandy', source: 'Colombo', destination: 'Kandy', distance: 115, fare: 350 },
    { routeId: 'SANDBOX-R2', routeName: 'Colombo - Galle', source: 'Colombo', destination: 'Galle', distance: 120, fare: 380 },
    { routeId: 'SANDBOX-R3', routeName: 'Kandy - Nuwara Eliya', source: 'Kandy', destination: 'Nuwara Eliya', distance: 80, fare: 250 },
    { routeId: 'SANDBOX-R4', routeName: 'Colombo - Negombo', source: 'Colombo', destination: 'Negombo', distance: 35, fare: 150 },
    { routeId: 'SANDBOX-R5', routeName: 'Galle - Matara', source: 'Galle', destination: 'Matara', distance: 45, fare: 180 },
  ];

  return Route.insertMany(fixtures.map((fixture) => ({ ...fixture, isActive: true, isDeleted: false })));
}

// Custom (driver-recorded) routes, one in each state a manager can meet them:
//   RECORDING      - 2 of 5 rides in, the driver app shows "ride 3 of 5"
//   PENDING_REVIEW - all 5 rides merged, waiting on the manager's Confirm
//   ACTIVE         - confirmed and live
// Each has its own vehicle and driver so the driver app can be signed into any state.
// The "roads" are straight lines near Colombo - enough to draw and review on a map.
async function seedCustomRoutes(managers) {
  const manager = managers[0];
  const ride = (dLng, n = 40) => Array.from({ length: n }, (_, i) => ({
    lat: 6.9 + (0.02 * i) / (n - 1),
    lng: 79.85 + dLng,
    t: 1_700_000_000_000 + i * 5000,
    acc: 8,
  }));
  const toLine = (points) => points.map((p) => ({ lat: p.lat, lng: p.lng }));

  const fixtures = [
    { key: 'RECORDING', status: 'RECORDING', accepted: 2, name: 'Custom Route Driver (recording)' },
    { key: 'PENDING', status: 'PENDING_REVIEW', accepted: 5, name: 'Custom Route Driver (to review)' },
    { key: 'ACTIVE', status: 'ACTIVE', accepted: 5, name: 'Custom Route Driver (live)' },
  ];
  const offsets = [0, 0.00003, -0.00003, 0.00002, -0.00002];
  const created = [];

  for (const [index, fixture] of fixtures.entries()) {
    const driver = await Driver.create({
      name: fixture.name,
      driverCode: await generateUniqueDriverCode(Driver),
      password: SANDBOX_PASSWORD,
      phoneNumber: '0770000000',
      isActive: true,
      isPrivate: false,
      managerId: manager._id,
    });

    const built = fixture.status !== 'RECORDING';
    const line = encodePolyline(toLine(ride(0)));
    const route = await Route.create({
      routeId: `SANDBOX-CUST-${fixture.key}`,
      routeName: fixture.status === 'ACTIVE' ? 'Greenfield School Run' : 'Recording…',
      source: fixture.status === 'ACTIVE' ? 'Home' : 'Recording…',
      destination: fixture.status === 'ACTIVE' ? 'Greenfield School' : 'Recording…',
      distance: built ? 2.2 : 0,
      estimatedTime: built ? 26 : 0,
      fare: 0,
      origin: 'RECORDED',
      status: fixture.status,
      managerId: manager._id,
      createdBy: manager._id,
      isActive: true,
      isDeleted: false,
      pathPolyline: built ? line : '',
      stops: built ? [
        { stopName: "Nimal's house", order: 1, lat: 6.905, lng: 79.85 },
        { stopName: 'School gate', order: 2, lat: 6.915, lng: 79.85 },
      ] : [],
      stopsCount: built ? 2 : 0,
      recording: {
        requiredRuns: 5,
        acceptedRuns: fixture.accepted,
        confidence: built ? 0.97 : null,
        warning: '',
        builtAt: built ? new Date() : null,
      },
    });

    const vehicle = await Vehicle.create({
      vehicleId: `SANDBOX-CUSTOM-${index + 1}`,
      vehicleName: `Sandbox Custom Shuttle ${index + 1}`,
      registrationNumber: `SB-CUST-${index + 1}`,
      numberPlate: `SB-${2000 + index}`,
      routeId: route.routeId,
      driverId: driver._id,
      managerId: manager._id,
      seatCapacity: 20,
      isActive: true,
      isDeleted: false,
    });

    await RouteRecordingRun.insertMany(Array.from({ length: fixture.accepted }, (_, i) => {
      const points = ride(offsets[i]);
      return {
        routeId: route.routeId,
        vehicleId: vehicle._id,
        driverId: driver._id,
        managerId: manager._id,
        clientRunId: `sandbox-${fixture.key}-${i + 1}`,
        runNumber: i + 1,
        status: 'ACCEPTED',
        startedAt: new Date(1_700_000_000_000),
        endedAt: new Date(1_700_000_000_000 + 1_500_000),
        durationSec: 1500,
        distanceM: 2200,
        points,
        stops: [{ lat: 6.905, lng: 79.85 + offsets[i], name: "Nimal's house" }, { lat: 6.915, lng: 79.85 + offsets[i], name: 'School gate' }],
        matched: { polyline: encodePolyline(toLine(points)), confidence: 0.9, provider: 'osrm', matchedAt: new Date() },
      };
    }));
    created.push({ route, vehicle, driver });
  }
  return created;
}

// Enrols the sandbox rider with the LIVE custom-route driver and saves a pickup place beside the first
// stop ("Nimal's house"), so driving that shuttle past the stop in the sandbox raises the parent's
// "your shuttle has arrived" notification. Without a pickup place no rider is tied to a stop.
async function seedCustomRouteEnrollment(rider, customRoutes) {
  const live = customRoutes.find((c) => c.route.status === 'ACTIVE');
  if (!live) return null;
  const place = await HouseholdPlace.create({
    accountId: rider._id,
    label: 'Home',
    address: "Next to Nimal's house (sandbox)",
    coordinates: { lat: 6.9052, lng: 79.8503 },
  });
  await DriverEnrollment.create({
    studentId: rider._id,
    driverId: live.driver._id,
    managerId: live.driver.managerId || null,
    status: 'ACTIVE',
    requiredApproval: false,
    pickupPlaceId: place._id,
  });
  return { driver: live.driver, vehicle: live.vehicle, place };
}

async function seedVehicles(managers, drivers, routes) {
  const fixtures = Array.from({ length: 6 }, (_, i) => ({
    vehicleId: `SANDBOX-VEHICLE-${i + 1}`,
    vehicleName: `Sandbox Vehicle ${i + 1}`,
    registrationNumber: `SB-${1000 + i}`,
    numberPlate: `SB-${1000 + i}`,
    routeId: routes[i % routes.length].routeId,
    driverId: drivers[i % drivers.length]._id,
    managerId: managers[i % managers.length]._id,
    seatCapacity: 40,
  }));

  return Vehicle.insertMany(fixtures.map((fixture) => ({ ...fixture, isActive: true, isDeleted: false })));
}

async function seedRider() {
  const { doc: rider } = await createIdentityWithProfile({
    email: 'rider.sandbox@trackme.dev',
    password: SANDBOX_PASSWORD,
    isEmailVerified: true,
    role: 'user',
    fields: {
      name: 'Sandbox Rider',
      phoneNumber: '0770000001',
      isActive: true,
      isEmailVerified: true,
    },
  });
  return rider;
}

// Two managed (dependant) profiles under the sandbox rider's identity — the
// fixture Developer Mode needs to exercise the multi-rider-profiles feature:
// one identity holding several User documents, only the first of which
// (seedRider, above) carries the mirrored Identity.email. Created directly
// via User.create rather than createIdentityWithProfile: a managed profile
// has no login of its own, so there is nothing to attach a profile to — see
// docs/modules/PROFILES.md.
async function seedManagedProfiles(rider) {
  const fixtures = [
    { name: 'Sandbox Child A', relation: 'Daughter' },
    { name: 'Sandbox Child B', relation: 'Son' },
  ];

  const profiles = [];
  for (const fixture of fixtures) {
    const profile = await User.create({
      name: fixture.name,
      relation: fixture.relation,
      identityId: rider.identityId,
      profileKind: 'MANAGED',
      isActive: true,
    });
    profiles.push(profile);
  }
  return profiles;
}

// Gives the sandbox rider an actual RiderProfile and an ACTIVE enrolment with
// the first seeded driver, and stamps a current position for the first two
// vehicles — one live, one offline. Without this, Developer Mode's live-map
// screens have nothing real to show: vehicle:subscribe requires a genuine
// ACTIVE DriverEnrollment, which nothing else in this script creates.
async function seedLiveTracking(rider, drivers, vehicles) {
  const riderProfile = await RiderProfile.create({
    _id: rider._id,
    accountId: rider._id,
    riderCode: await generateUniqueRiderCode(RiderProfile),
    fullName: rider.name,
    // What the rider would have answered while creating the account, so the
    // profile screen and the enrolment form's prefill have something to show.
    category: 'SCHOOL',
    details: { grade: '7' },
  });

  const enrolledDriver = drivers[0];
  await DriverEnrollment.create({
    studentId: riderProfile._id,
    driverId: enrolledDriver._id,
    managerId: enrolledDriver.managerId || null,
    status: 'ACTIVE',
    requiredApproval: false,
  });

  // A second enrolment, still queued, with a PRIVATE driver of the same manager.
  // The manager's Enrollments screen needs both states to be worth looking at:
  // ACTIVE is someone already riding (the Enrolled tab and the Riders count on
  // the driver directory), PENDING is someone awaiting a decision.
  const pendingDriver = drivers.find((d) => (
    d.isPrivate && String(d.managerId) === String(enrolledDriver.managerId)
  ));
  if (pendingDriver) {
    await DriverEnrollment.create({
      studentId: riderProfile._id,
      driverId: pendingDriver._id,
      managerId: pendingDriver.managerId || null,
      status: 'PENDING',
      requiredApproval: true,
    });
  }

  const liveVehicle = vehicles.find((v) => String(v.driverId) === String(enrolledDriver._id));
  if (liveVehicle) {
    await VehicleLiveLocation.create({
      vehicleId: liveVehicle.vehicleId,
      vehicleRef: liveVehicle._id,
      driverId: liveVehicle.driverId,
      managerId: liveVehicle.managerId,
      routeId: liveVehicle.routeId || '',
      lat: 6.9271,
      lng: 79.8612,
      speed: 8.5,
      heading: 42,
      live: true,
      sessionId: 'sandbox-session-1',
      startedAt: new Date(),
      recordedAt: new Date(),
      receivedAt: new Date(),
    });
  }

  // A second vehicle recorded as recently stopped, so the UI's offline state
  // has a real fixture too, not just an absent document.
  const offlineVehicle = vehicles.find((v) => v.vehicleId !== liveVehicle?.vehicleId);
  if (offlineVehicle) {
    const endedAt = new Date(Date.now() - 15 * 60 * 1000);
    await VehicleLiveLocation.create({
      vehicleId: offlineVehicle.vehicleId,
      vehicleRef: offlineVehicle._id,
      driverId: offlineVehicle.driverId,
      managerId: offlineVehicle.managerId,
      routeId: offlineVehicle.routeId || '',
      lat: 7.2906,
      lng: 80.6337,
      live: false,
      sessionId: 'sandbox-session-2',
      startedAt: new Date(endedAt.getTime() - 20 * 60 * 1000),
      endedAt,
      endedReason: 'DRIVER_STOPPED',
      recordedAt: endedAt,
      receivedAt: endedAt,
    });
  }

  return { riderProfile, enrolledDriver, liveVehicle, offlineVehicle };
}

async function seedBookings(routes, vehicles, rider) {
  const routesById = new Map(routes.map((route) => [route.routeId, route]));

  const fixtures = Array.from({ length: 12 }, (_, i) => {
    const vehicle = vehicles[i % vehicles.length];
    const route = routesById.get(vehicle.routeId);
    return {
      userId: rider._id,
      vehicleId: vehicle._id,
      routeId: route._id,
      seatNumbers: [i + 1],
      totalPassengers: 1,
      pricePerSeat: route.fare,
      totalPrice: route.fare,
      journeyDate: new Date(Date.now() + (i + 1) * 24 * 60 * 60 * 1000),
      status: i % 4 === 0 ? 'CANCELLED' : 'CONFIRMED',
      passengerDetails: [{ name: 'Sandbox Rider', phone: '0770000001', gender: 'O', age: 30 }],
    };
  });

  return Booking.insertMany(fixtures);
}

async function seedPendingRequests(managers, vehicles) {
  return ManagerVehicleRequest.insertMany([
    {
      type: 'CREATE_VEHICLE_ACCOUNT',
      status: 'PENDING',
      managerId: managers[0]._id,
      vehicleId: 'SANDBOX-PENDING-1',
      reason: 'New route coverage',
      payload: { vehicleName: 'Pending Vehicle 1', numberPlate: 'SB-9001' },
    },
    {
      type: 'CREATE_VEHICLE_ACCOUNT',
      status: 'PENDING',
      managerId: managers[1]._id,
      vehicleId: 'SANDBOX-PENDING-2',
      reason: 'Fleet expansion',
      payload: { vehicleName: 'Pending Vehicle 2', numberPlate: 'SB-9002' },
    },
    {
      type: 'DELETE_VEHICLE',
      status: 'PENDING',
      managerId: managers[0]._id,
      vehicleId: vehicles[0].vehicleId,
      reason: 'Vehicle retired',
      payload: null,
    },
  ]);
}

// Account deletion (docs/modules/AUTH.md §8): a second rider whose account is
// waiting to be deleted, so signing in as them shows the rider app's
// keep-or-continue screen, and one manager bell notice for web-admin.
async function seedAccountDeletion(managers) {
  const requestedAt = new Date();
  const { doc: rider } = await createIdentityWithProfile({
    email: 'leaving.sandbox@trackme.dev',
    password: SANDBOX_PASSWORD,
    isEmailVerified: true,
    role: 'user',
    fields: { name: 'Sandbox Leaving Rider', isActive: true, isEmailVerified: true },
  });
  rider.deletion = { requestedAt, purgeAt: new Date(requestedAt.getTime() + graceMs()), enrollmentSnapshot: [] };
  await rider.save();

  await Notification.create({
    userId: managers[0]._id,
    recipientRole: 'manager',
    type: 'RIDER_ACCOUNT_DELETED',
    title: 'Rider left',
    message: "Sandbox Leaving Rider left Sandbox Driver's shuttle because they are deleting their account.",
    data: { type: 'RIDER_ACCOUNT_DELETED' },
  });
  return rider;
}

async function main() {
  const { uri, dbName } = await assertSandboxDatabase();

  await mongoose.connect(uri);
  console.log(`Connected to sandbox database: ${dbName}`);

  // A throwaway database can end up with indexes from an older schema version (e.g. a
  // once-required `email` index that is now sparse) — sync every model's indexes to
  // what the current code actually declares before seeding against them.
  await Promise.all(
    [
      Identity, SuperAdmin, Manager, Driver, User, Vehicle, Route, Booking, ManagerVehicleRequest,
      RiderProfile, DriverEnrollment, VehicleLiveLocation, RouteRecordingRun,
    ].map((model) => model.syncIndexes())
  );

  console.log('Wiping sandbox collections...');
  await wipeCollections();

  const mirrorId = await seedSuperAdmin();
  console.log(`Seeded super admin (mirrored _id ${mirrorId})`);

  const managers = await seedManagers();
  console.log(`Seeded ${managers.length} managers`);

  const drivers = await seedDrivers(managers);
  console.log(`Seeded ${drivers.length} drivers`);

  const routes = await seedRoutes();
  console.log(`Seeded ${routes.length} routes`);

  const vehicles = await seedVehicles(managers, drivers, routes);
  console.log(`Seeded ${vehicles.length} vehicles`);

  const rider = await seedRider();
  console.log('Seeded sandbox rider (primary profile)');

  const managedProfiles = await seedManagedProfiles(rider);
  console.log(`Seeded ${managedProfiles.length} managed profiles under the sandbox rider`);

  const live = await seedLiveTracking(rider, drivers, vehicles);
  console.log(
    `Seeded live tracking: rider enrolled with ${live.enrolledDriver.name}`
    + (live.liveVehicle ? `, ${live.liveVehicle.vehicleId} live` : '')
    + (live.offlineVehicle ? `, ${live.offlineVehicle.vehicleId} offline` : '')
  );

  const bookings = await seedBookings(routes, vehicles, rider);
  console.log(`Seeded ${bookings.length} bookings`);

  const pendingRequests = await seedPendingRequests(managers, vehicles);
  console.log(`Seeded ${pendingRequests.length} pending requests`);

  await seedAccountDeletion(managers);
  console.log('Seeded a rider pending deletion and a manager bell notice');

  const customRoutes = await seedCustomRoutes(managers);
  console.log(`Seeded ${customRoutes.length} custom routes (recording, to review, live)`);

  const customEnrollment = await seedCustomRouteEnrollment(rider, customRoutes);
  if (customEnrollment) {
    console.log(`Enrolled the sandbox rider with ${customEnrollment.driver.name} (pickup beside stop 1, for the arrival alert)`);
  }

  console.log('Sandbox seed complete.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Sandbox seed failed:', err);
  process.exit(1);
});
