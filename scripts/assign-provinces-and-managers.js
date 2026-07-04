// Classifies every route by Sri Lanka province (nearest-centroid over its stop
// coordinates), ensures one manager account per province, and links each route to
// its province's manager (Route.province + Route.createdBy). Idempotent — safe to
// re-run; existing managers are upserted, not duplicated.
//
// Usage: node scripts/assign-provinces-and-managers.js [--dry]
//   --dry  Only print the province breakdown, make no DB writes.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Route = require('../src/models/Route');

const DRY_RUN = process.argv.includes('--dry');

// Real Sri Lanka province boundaries (ADM1), from geoBoundaries.org (open data,
// ODbL). Used for accurate point-in-polygon classification instead of a crude
// nearest-centroid guess.
const geojson = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'sl-provinces.geojson'), 'utf8')
);

const SLUGS = {
  'Western Province': 'western',
  'Central Province': 'central',
  'Southern Province': 'southern',
  'Northern Province': 'northern',
  'Eastern Province': 'eastern',
  'North Western Province': 'northwestern',
  'North Central Province': 'northcentral',
  'Uva Province': 'uva',
  'Sabaragamuwa Province': 'sabaragamuwa'
};

const PROVINCES = geojson.features.map((f) => ({
  name: f.properties.shapeName.replace(' Province', ''),
  slug: SLUGS[f.properties.shapeName],
  geometry: f.geometry
}));

const MANAGER_PASSWORD = process.env.PROVINCE_MANAGER_PASSWORD || 'Province@123';

// Ray-casting point-in-polygon for a single [ [lng,lat], ... ] ring.
const pointInRing = (lng, lat, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const pointInPolygonCoords = (lng, lat, polygonCoords) => {
  // polygonCoords = [ outerRing, hole1, hole2, ... ]
  if (!pointInRing(lng, lat, polygonCoords[0])) return false;
  for (let h = 1; h < polygonCoords.length; h += 1) {
    if (pointInRing(lng, lat, polygonCoords[h])) return false; // inside a hole
  }
  return true;
};

const pointInGeometry = (lng, lat, geometry) => {
  if (geometry.type === 'Polygon') {
    return pointInPolygonCoords(lng, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly) => pointInPolygonCoords(lng, lat, poly));
  }
  return false;
};

// Exact point-in-polygon lookup; falls back to nearest-vertex-distance if a point
// falls just outside every polygon (coastline simplification / sea-adjacent stop).
const findProvince = (lat, lng) => {
  for (const p of PROVINCES) {
    if (pointInGeometry(lng, lat, p.geometry)) return p;
  }
  return nearestProvinceFallback(lat, lng);
};

const ringMinDist = (lng, lat, ring) => {
  let best = Infinity;
  for (const [x, y] of ring) {
    const d = (x - lng) ** 2 + (y - lat) ** 2;
    if (d < best) best = d;
  }
  return best;
};

const nearestProvinceFallback = (lat, lng) => {
  let best = null;
  let bestDist = Infinity;
  for (const p of PROVINCES) {
    const rings = p.geometry.type === 'Polygon' ? [p.geometry.coordinates[0]] : p.geometry.coordinates.map((poly) => poly[0]);
    for (const ring of rings) {
      const d = ringMinDist(lng, lat, ring);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
  }
  return best;
};

// Route "location" = its origin (first) stop. Most routes are Colombo-anchored
// (e.g. "Hakmana - Colombo (Pettah)"), so averaging all stops drags long routes'
// midpoint into the hill country between the two ends, systematically misclassifying
// them. Using the origin stop mirrors how real provincial road passenger transport
// authorities assign a route to a province: by where it's based/originates.
const routeLatLng = (route) => {
  const stops = (route.stops || []).filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
  if (!stops.length) return null;
  const origin = stops.find((s) => s.order === 0) || stops[0];
  return [origin.lat, origin.lng];
};

const ensureManager = async (province) => {
  const email = `${province.slug}.manager@trackme.com`;
  let manager = await User.findOne({ email });
  if (!manager) {
    manager = await User.create({
      name: `${province.name} Province Manager`,
      email,
      password: MANAGER_PASSWORD,
      role: 'admin',
      province: province.name,
      isEmailVerified: true,
      isActive: true
    });
    console.log(`  created manager: ${email}`);
  } else {
    let changed = false;
    if (manager.role !== 'admin') { manager.role = 'admin'; changed = true; }
    if (manager.province !== province.name) { manager.province = province.name; changed = true; }
    if (!manager.isEmailVerified) { manager.isEmailVerified = true; changed = true; }
    if (!manager.isActive) { manager.isActive = true; changed = true; }
    if (changed) await manager.save();
    console.log(`  existing manager: ${email}`);
  }
  return manager;
};

const run = async () => {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const routes = await Route.find({ isDeleted: false }).lean();
  console.log(`Loaded ${routes.length} routes`);

  const buckets = new Map(PROVINCES.map((p) => [p.name, []]));
  let unclassified = 0;

  for (const route of routes) {
    const latLng = routeLatLng(route);
    if (!latLng) {
      unclassified += 1;
      continue;
    }
    const province = findProvince(latLng[0], latLng[1]);
    buckets.get(province.name).push(route);
  }

  console.log('\n--- Province breakdown ---');
  for (const p of PROVINCES) {
    console.log(`${p.name.padEnd(15)} ${buckets.get(p.name).length}`);
  }
  console.log(`${'Unclassified (no coords)'.padEnd(15)} ${unclassified}`);
  console.log(`Total classified: ${routes.length - unclassified} / ${routes.length}`);

  if (DRY_RUN) {
    console.log('\n--dry run: no DB writes made.');
    await mongoose.connection.close();
    return;
  }

  console.log('\n--- Ensuring manager accounts ---');
  const managers = new Map();
  for (const p of PROVINCES) {
    const manager = await ensureManager(p);
    managers.set(p.name, manager);
  }

  console.log('\n--- Updating routes ---');
  let updated = 0;
  for (const [provinceName, provinceRoutes] of buckets.entries()) {
    if (!provinceRoutes.length) continue;
    const manager = managers.get(provinceName);
    const ids = provinceRoutes.map((r) => r._id);
    const res = await Route.updateMany(
      { _id: { $in: ids } },
      { $set: { province: provinceName, createdBy: manager._id } }
    );
    updated += res.modifiedCount;
    console.log(`  ${provinceName}: linked ${provinceRoutes.length} routes -> ${manager.email}`);
  }

  console.log(`\nDone. ${updated} routes updated.`);
  console.log('\nManager credentials (password same for all, from PROVINCE_MANAGER_PASSWORD env or default):');
  for (const p of PROVINCES) {
    console.log(`  ${p.name.padEnd(15)} ${p.slug}.manager@trackme.com  /  ${MANAGER_PASSWORD}`);
  }

  await mongoose.connection.close();
};

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
