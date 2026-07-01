/**
 * Fix distance/fare/stop-positions for routes that have accurate stored geometry
 * (pathPolyline), using ONLY the stored polyline — no API calls.
 *
 * The seeded stop coordinates were geocoded from ambiguous names and some landed far
 * away, which made distance-from-stops (and fare, and stop markers) wrong. The stored
 * polyline is the real route, so:
 *   - distance  = length along the polyline (real km)
 *   - fare/time = derived from the real distance
 *   - each stop = snapped onto its nearest point on the polyline (marker sits on the line)
 *
 * Run:  node scripts/fix-geometry-derived-fields.js
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Route = require('../src/models/Route');
const { _decodePolyline: decodePolyline } = require('../src/controllers/routeGeometryController');

dotenv.config();

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function nearestOnLine(pt, line) {
  let best = line[0], bestD = Infinity;
  for (const c of line) {
    const d = (c.lat - pt.lat) ** 2 + (c.lng - pt.lng) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackme');
  const routes = await Route.find({ pathPolyline: { $type: 'string', $regex: /.+/ } });
  console.log(`Fixing ${routes.length} routes with stored geometry...`);

  let fixed = 0;
  for (const r of routes) {
    const line = decodePolyline(r.pathPolyline);
    if (line.length < 2) continue;

    // real distance along the polyline
    let km = 0;
    for (let i = 1; i < line.length; i += 1) km += haversineKm(line[i - 1], line[i]);
    r.distance = Math.round(km);
    r.estimatedTime = Math.round(km * 2.6);
    r.fare = Math.max(20, Math.round(km * 0.65));

    // snap each stop onto the line so markers sit on the real route
    r.stops = (r.stops || []).map((s, i) => {
      const snapped = nearestOnLine({ lat: s.lat, lng: s.lng }, line);
      return { stopName: s.stopName, order: i, lat: snapped.lat, lng: snapped.lng };
    });

    await r.save();
    fixed += 1;
  }
  console.log(`Done. Fixed ${fixed} routes (distance/fare/stops from real geometry).`);
  await mongoose.connection.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
