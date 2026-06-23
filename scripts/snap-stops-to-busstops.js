/**
 * Snap every route stop to the nearest REAL bus stop (Google Places Nearby).
 *
 * The seeded stop coordinates were town centroids, so route terminals floated in
 * the middle of a block instead of sitting on a bus stand. This moves each unique
 * stop onto the closest bus_station / bus_stop / transit_station, then rewrites
 * every route's stops by name. Run once; re-runnable (idempotent-ish).
 *
 * Run:  node scripts/snap-stops-to-busstops.js
 * Needs: GOOGLE_PLACES_KEY in .env and the Places API (New) enabled.
 *
 * After running, RESTART the backend so the in-memory road-path cache recomputes.
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Route = require('../src/models/Route');

dotenv.config();

const KEY = process.env.GOOGLE_PLACES_KEY;
const SEARCH_RADIUS_M = 1000;        // don't snap further than this
const TYPE_RANK = { bus_station: 0, bus_stop: 1, transit_station: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversineM(a, b, x, y) {
  const R = 6371000, p = Math.PI / 180;
  return 2 * R * Math.asin(Math.sqrt(
    Math.sin((x - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(x * p) * Math.sin((y - b) * p / 2) ** 2,
  ));
}

// Nearest bus-type place to (lat,lng); prefers bus_station > bus_stop > transit_station.
async function nearestBusStop(lat, lng) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'places.displayName,places.location,places.types',
    },
    body: JSON.stringify({
      includedTypes: ['bus_station', 'bus_stop', 'transit_station'],
      maxResultCount: 10,
      rankPreference: 'DISTANCE',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: SEARCH_RADIUS_M } },
    }),
  });
  if (!res.ok) {
    console.error(`  Places error ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return null;
  }
  const data = await res.json();
  const cands = (data.places || []).map((p) => {
    const tier = Math.min(...(p.types || []).map((t) => (t in TYPE_RANK ? TYPE_RANK[t] : 9)), 9);
    const dist = haversineM(lat, lng, p.location.latitude, p.location.longitude);
    return { name: p.displayName?.text, lat: p.location.latitude, lng: p.location.longitude, tier, dist };
  }).filter((c) => c.tier < 9 && c.dist <= SEARCH_RADIUS_M);
  if (!cands.length) return null;
  cands.sort((a, b) => (a.tier - b.tier) || (a.dist - b.dist));
  return cands[0];
}

(async () => {
  if (!KEY) { console.error('Missing GOOGLE_PLACES_KEY'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackme');
  console.log('Connected to MongoDB');

  const routes = await Route.find({ isDeleted: false });

  // Unique stops by name (search once per name; shared stops stay consistent).
  const uniq = new Map(); // name -> {lat,lng}
  for (const r of routes) {
    for (const s of r.stops || []) {
      if (!uniq.has(s.stopName) && Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
        uniq.set(s.stopName, { lat: s.lat, lng: s.lng });
      }
    }
  }
  console.log(`Resolving ${uniq.size} unique stops...\n`);

  const snapped = new Map(); // name -> {lat,lng}
  let moved = 0, kept = 0;
  for (const [name, { lat, lng }] of uniq) {
    const best = await nearestBusStop(lat, lng);
    if (best) {
      snapped.set(name, { lat: best.lat, lng: best.lng });
      moved++;
      console.log(`  ✓ ${name.padEnd(22)} -> "${best.name}" (${Math.round(best.dist)}m, ${best.tier === 0 ? 'bus_station' : best.tier === 1 ? 'bus_stop' : 'transit'})`);
    } else {
      snapped.set(name, { lat, lng });
      kept++;
      console.log(`  · ${name.padEnd(22)} -> no bus stop within ${SEARCH_RADIUS_M}m, kept original`);
    }
    await sleep(120);
  }

  // Rewrite every route's stop coords from the snapped map.
  let updatedRoutes = 0;
  for (const r of routes) {
    let changed = false;
    for (const s of r.stops || []) {
      const snap = snapped.get(s.stopName);
      if (snap && (s.lat !== snap.lat || s.lng !== snap.lng)) {
        s.lat = snap.lat; s.lng = snap.lng; changed = true;
      }
    }
    if (changed) { r.markModified('stops'); await r.save(); updatedRoutes++; }
  }

  console.log(`\nDone. Stops snapped: ${moved}, kept: ${kept}. Routes updated: ${updatedRoutes}.`);
  console.log('RESTART the backend so the road-path cache recomputes with the new coords.');
  await mongoose.disconnect();
  process.exit(0);
})();
