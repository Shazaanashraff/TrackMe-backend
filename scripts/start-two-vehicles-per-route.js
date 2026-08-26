// Simulates drivers going live: logs in as real seeded drivers over HTTP and
// broadcasts location the same way the driver app does, over the socket.
//
// The previous version of this script wrote straight into the (now deleted)
// LiveLocation collection, bypassing the socket layer entirely — it also
// flipped Vehicle.isActive to mean "currently driving", which is a fleet-status
// field a manager edits, not a duty flag. Rewritten as a socket client so it
// exercises the real path this feature depends on: authorization, the upsert,
// and the vehicle:update fan-out. A rider or manager watching in another tab
// sees these vehicles move exactly as they would a real driver's phone.
//
// Requires: `npm run seed:sandbox` (or a dev DB with matching drivers/vehicles)
// and the backend already running. Point BACKEND_URL/MONGODB_URI at whichever
// database the running backend is using.
require('dotenv').config();
const { io } = require('socket.io-client');
const mongoose = require('mongoose');
const Driver = require('../src/models/Driver');
const Vehicle = require('../src/models/Vehicle');
const Route = require('../src/models/Route');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';
const ACTIVE_VEHICLES_PER_ROUTE = Number(process.env.ACTIVE_VEHICLES_PER_ROUTE) || 2;
const EMIT_INTERVAL_MS = Number(process.env.SIM_EMIT_INTERVAL_MS) || 3000;
const STEP_METERS = Number(process.env.SIM_STEP_METERS) || 25;
const DRIVER_PASSWORD = process.env.SANDBOX_DRIVER_PASSWORD || process.env.SANDBOX_PASSWORD;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function movePoint(lat, lng, bearingDeg, distanceMeters) {
  const earthRadius = 6371000;
  const bearing = toRad(bearingDeg);
  const latRad = toRad(lat);
  const lngRad = toRad(lng);
  const angularDistance = distanceMeters / earthRadius;

  const nextLat = Math.asin(
    Math.sin(latRad) * Math.cos(angularDistance)
    + Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const nextLng = lngRad + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
    Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(nextLat)
  );

  return { lat: toDeg(nextLat), lng: toDeg(nextLng) };
}

function routeGeometry(route) {
  const stops = [...(route?.stops || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const points = stops
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({ lat: s.lat, lng: s.lng }));
  if (points.length >= 2) return points;

  // No usable stop geometry: walk a small loop around Colombo so the script is
  // still useful against a route with no recorded stops.
  const base = { lat: 6.9271, lng: 79.8612 };
  return Array.from({ length: 8 }, (_, i) => movePoint(base.lat, base.lng, i * 45, 400));
}

// Bounces back and forth along the point list rather than looping through it,
// so a short route still produces continuous, plausible movement.
function makeWalker(points, startOffset = 0) {
  let index = startOffset % Math.max(points.length - 1, 1);
  let forward = true;

  return () => {
    const from = points[index];
    const to = points[forward ? index + 1 : index - 1] || from;
    const bearing = Math.atan2(to.lng - from.lng, to.lat - from.lat) * (180 / Math.PI);
    const moved = movePoint(from.lat, from.lng, bearing, STEP_METERS);

    if (forward) {
      index += 1;
      if (index >= points.length - 1) forward = false;
    } else {
      index -= 1;
      if (index <= 0) forward = true;
    }

    return { ...moved, heading: (bearing + 360) % 360 };
  };
}

async function loginDriver(driverCode) {
  const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: driverCode, password: DRIVER_PASSWORD, audience: 'driver' })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message || `login failed (${res.status})`);
  return body.accessToken || body.data?.accessToken;
}

function connectDriverSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BACKEND_URL, { auth: { token }, transports: ['websocket'] });
    socket.on('connection-success', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (ack) => {
      if (ack?.success) resolve(ack);
      else reject(new Error(`${event} refused: ${ack?.code || 'unknown'} ${ack?.error || ''}`));
    });
  });
}

async function runVehicle({ vehicle, route, driverToken, offset }) {
  const socket = await connectDriverSocket(driverToken);
  await emitAck(socket, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });
  console.log(`  ${vehicle.vehicleId} → live on ${route?.routeId || '(no route)'}`);

  const points = routeGeometry(route);
  const walk = makeWalker(points, offset);

  const timer = setInterval(async () => {
    const { lat, lng, heading } = walk();
    try {
      await emitAck(socket, 'driver:location', {
        vehicleId: vehicle.vehicleId,
        routeId: route?.routeId || '',
        lat,
        lng,
        heading,
        speed: 8 + Math.random() * 4,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error(`  ${vehicle.vehicleId}: ${error.message}`);
    }
  }, EMIT_INTERVAL_MS);

  return { socket, timer };
}

async function main() {
  if (!DRIVER_PASSWORD) {
    console.error(
      'Set SANDBOX_PASSWORD (or SANDBOX_DRIVER_PASSWORD) to the seeded drivers’ password — '
      + 'see .env.sandbox.example.'
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackme_test');
  console.log(`Connected to MongoDB for vehicle/route lookup: ${mongoose.connection.name}`);

  const routes = await Route.find({ isDeleted: false, isActive: true }).sort({ routeId: 1 }).lean();
  const sessions = [];

  for (const route of routes) {
    const vehicles = await Vehicle.find({ routeId: route.routeId, isDeleted: false, driverId: { $ne: null } })
      .sort({ vehicleId: 1 })
      .limit(ACTIVE_VEHICLES_PER_ROUTE)
      .lean();

    if (!vehicles.length) {
      console.log(`Route ${route.routeId}: no drivable vehicles`);
      continue;
    }

    console.log(`Route ${route.routeId}: starting ${vehicles.length} vehicle(s)`);
    for (const [index, vehicle] of vehicles.entries()) {
      const driver = await Driver.findById(vehicle.driverId).lean();
      if (!driver?.driverCode) {
        console.log(`  ${vehicle.vehicleId}: assigned driver has no driverCode, skipping`);
        continue;
      }
      try {
        const driverToken = await loginDriver(driver.driverCode);
        // eslint-disable-next-line no-await-in-loop
        const session = await runVehicle({ vehicle, route, driverToken, offset: index * 3 });
        sessions.push(session);
      } catch (error) {
        console.error(`  ${vehicle.vehicleId}: failed to start (${error.message})`);
      }
    }
  }

  if (!sessions.length) {
    console.log('No vehicles started.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${sessions.length} vehicle(s) broadcasting. Press Ctrl+C to stop.`);

  const shutdown = async () => {
    console.log('\nStopping...');
    for (const { socket, timer } of sessions) {
      clearInterval(timer);
      socket.disconnect();
    }
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Simulation failed:', error.message);
  process.exit(1);
});
