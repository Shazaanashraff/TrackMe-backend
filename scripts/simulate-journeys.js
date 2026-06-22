/**
 * Data-driven live bus journey simulator.
 *
 * Uses the real Western Province fleet figures (scripts/wp-fleet-data.js,
 * transcribed from the 2020 WP route dataset) to decide HOW MANY buses run on
 * each route, scaled by TIME OF DAY (operating hours + morning/evening peaks),
 * and spreads them WHERE they should be along the route. Each simulated bus
 * connects as its assigned driver and emits `driver:location`, which the server
 * persists and broadcasts to the UserApp live map.
 *
 * Requires the backend running and data seeded:
 *   BUSES_PER_ROUTE=8 npm run seed:manager-buses
 *
 * Run:  npm run simulate      (Ctrl+C to stop)
 *
 * Tunables (env):
 *   SIM_MAX_PER_ROUTE  cap on concurrently simulated buses per route (default 8)
 *   SIM_TICK_MS        ms between position updates per bus (default 2000)
 *   SIM_STEPS          interpolation points between two stops (default 25)
 *   SIM_REFRESH_MIN    minutes between re-evaluating time-of-day fleet (default 5)
 *   SIM_FORCE_HOUR     pin the time-of-day hour 0-23 (for testing peak/night)
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const Route = require('../src/models/Route');
const Bus = require('../src/models/Bus');
const FLEET = require('./wp-fleet-data');

dotenv.config();

const PORT = process.env.PORT || 5000;
const SERVER_URL = process.env.SIM_SERVER_URL || `http://localhost:${PORT}`;
const TICK_MS = Number(process.env.SIM_TICK_MS || 2000);
const STEPS_BETWEEN_STOPS = Number(process.env.SIM_STEPS || 25);
const MAX_PER_ROUTE = Number(process.env.SIM_MAX_PER_ROUTE || 8);
const REFRESH_MIN = Number(process.env.SIM_REFRESH_MIN || 5);

// Fraction of the daily fleet on the road at a given hour (0-23).
// Models WP service: ~05:00 start, morning + evening peaks, ~23:00 wind-down.
function timeOfDayFactor(hour) {
  if (hour < 5) return 0;        // 00:00-04:59 no service
  if (hour < 6) return 0.25;     // early start
  if (hour < 9) return 1.0;      // morning peak
  if (hour < 12) return 0.6;
  if (hour < 16) return 0.5;     // midday
  if (hour < 19) return 1.0;     // evening peak
  if (hour < 22) return 0.5;
  return 0.15;                   // 22:00-23:59 wind-down
}

function currentHour() {
  if (process.env.SIM_FORCE_HOUR !== undefined) return Number(process.env.SIM_FORCE_HOUR);
  return new Date().getHours();
}

// How many buses should currently be running on a route.
function concurrentCount(routeId, seededCount) {
  const fleet = FLEET[routeId]?.fleet ?? 2;
  const factor = timeOfDayFactor(currentHour());
  const wanted = Math.round(fleet * factor);
  return Math.max(0, Math.min(wanted, MAX_PER_ROUTE, seededCount));
}

// Dense list of waypoints by interpolating between ordered stops.
function buildWaypoints(stops) {
  const ordered = [...stops].sort((a, b) => (a.order || 0) - (b.order || 0));
  const pts = ordered
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));
  if (pts.length < 2) return pts;

  const path = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i], b = pts[i + 1];
    for (let step = 0; step < STEPS_BETWEEN_STOPS; step += 1) {
      const t = step / STEPS_BETWEEN_STOPS;
      path.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    }
  }
  path.push(pts[pts.length - 1]);
  return path;
}

function signDriverToken(driverId) {
  return jwt.sign({ id: String(driverId), tokenType: 'access' }, process.env.JWT_SECRET, { expiresIn: '12h' });
}

// One driven bus: owns a socket, walks the route, bounces at the ends.
function startBus(bus, waypoints, startIndex, direction) {
  const token = signDriverToken(bus.driverId);
  const socket = io(SERVER_URL, { auth: { token }, transports: ['websocket'], reconnection: true });
  let cursor = startIndex;
  let dir = direction;
  let timer = null;

  socket.on('connect', () => {
    if (timer) clearInterval(timer);
    socket.emit('driver:start-tracking', { busId: bus.busId }, () => {});
    timer = setInterval(() => {
      const p = waypoints[cursor];
      if (!p) return;
      socket.emit('driver:location', {
        busId: bus.busId,
        routeId: bus.routeId,
        lat: Number(p.lat.toFixed(6)),
        lng: Number(p.lng.toFixed(6)),
        accuracy: 8,
        speed: 28 + Math.round(Math.random() * 17),
      });
      cursor += dir;
      if (cursor >= waypoints.length - 1) { cursor = waypoints.length - 1; dir = -1; }
      else if (cursor <= 0) { cursor = 0; dir = 1; }
    }, TICK_MS);
  });

  socket.on('connect_error', (err) => console.error(`⚠️  ${bus.busId}: ${err.message}`));

  return {
    busId: bus.busId,
    stop: () => { if (timer) clearInterval(timer); socket.emit('driver:stop-tracking', { busId: bus.busId }, () => {}); socket.close(); },
  };
}

const running = new Map(); // routeId -> [ { busId, stop } ]
const routeCache = new Map(); // routeId -> { waypoints, buses[] }

async function reconcile() {
  const hour = currentHour();
  let total = 0;
  const summary = [];

  for (const [routeId, { waypoints, buses }] of routeCache.entries()) {
    const want = concurrentCount(routeId, buses.length);
    const active = running.get(routeId) || [];

    // Scale down
    while (active.length > want) active.pop().stop();
    // Scale up — spread new buses evenly along the path, alternating direction.
    while (active.length < want) {
      const i = active.length;
      const startIndex = Math.floor((i / Math.max(want, 1)) * (waypoints.length - 1));
      const bus = buses[i];
      active.push(startBus(bus, waypoints, startIndex, i % 2 === 0 ? 1 : -1));
    }
    running.set(routeId, active);
    total += active.length;
    if (active.length > 0) summary.push(`${routeId}:${active.length}`);
  }

  console.log(`\n🕒 ${String(hour).padStart(2, '0')}:00 (factor ${timeOfDayFactor(hour)}) — ${total} buses running across ${summary.length} routes`);
  console.log('   ' + summary.join('  '));
}

async function main() {
  if (!process.env.JWT_SECRET) { console.error('❌ JWT_SECRET missing'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackme');
  console.log('✅ Connected to MongoDB');

  const routes = await Route.find({ isActive: true, isDeleted: false }).lean();
  for (const route of routes) {
    const waypoints = buildWaypoints(route.stops || []);
    if (waypoints.length < 2) continue;
    const buses = await Bus.find({ routeId: route.routeId, isDeleted: false })
      .select('busId routeId driverId').sort({ busId: 1 }).lean();
    if (!buses.length) continue;
    routeCache.set(route.routeId, { waypoints, buses });
  }

  if (routeCache.size === 0) {
    console.error('❌ No routes with buses found. Run: BUSES_PER_ROUTE=8 npm run seed:manager-buses');
    process.exit(1);
  }

  console.log(`🚍 Loaded ${routeCache.size} routes. Fleet figures from WP 2020 dataset.`);
  console.log(`   Caps: max ${MAX_PER_ROUTE}/route, tick ${TICK_MS}ms, refresh every ${REFRESH_MIN} min.\n`);

  await reconcile();
  setInterval(reconcile, REFRESH_MIN * 60 * 1000);

  console.log('\nℹ️  Buses are moving (counts scale with time of day). Ctrl+C to stop.');
}

function shutdown() {
  console.log('\n🛑 Stopping simulation...');
  for (const active of running.values()) active.forEach((b) => b.stop());
  mongoose.connection.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => { console.error('❌ Simulation failed:', err.message); process.exit(1); });
