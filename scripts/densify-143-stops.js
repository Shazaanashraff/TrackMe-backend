// Route 143 (Hanwella - Colombo Pettah) real halt list. Stop NAMES come from actual
// route sources (routemaster.lk / busroutessrilanka), NOT guessed from the polyline.
// Each real town's approximate coordinate is snapped to the nearest point on the
// route's stored polyline, so stops sit on the drawn line, and stops are ordered by
// their true along-route distance. No invented halts.
//
// Sources: busroutessrilanka.blogspot.com/2018/09/143-hanwella-pettah.html
//          routemaster.lk/bus/143
//
// Usage: node scripts/densify-143-stops.js

require('dotenv').config();
const mongoose = require('mongoose');
const Route = require('../src/models/Route');

function decode(str) {
  let i = 0, lat = 0, lng = 0;
  const out = [];
  while (i < str.length) {
    let b, sh = 0, res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    lat += (res & 1) ? ~(res >> 1) : (res >> 1);
    sh = 0; res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    lng += (res & 1) ? ~(res >> 1) : (res >> 1);
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

function haversine(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Real 143 halts with approximate real-world coordinates (used only to snap onto the
// route line; final order is decided by along-route distance).
const REAL_STOPS = [
  { name: 'Hanwella', lat: 6.9078, lng: 80.0782 },
  { name: 'Embulgama', lat: 6.9095, lng: 80.0600 },
  { name: 'Ranala', lat: 6.9176, lng: 80.0360 },
  { name: 'Nawagamuwa', lat: 6.9300, lng: 80.0060 },
  { name: 'Kaduwela', lat: 6.9338, lng: 79.9862 },
  { name: 'Mulleriyawa', lat: 6.9430, lng: 79.9400 },
  { name: 'Angoda', lat: 6.9370, lng: 79.9300 },
  { name: 'Kotikawatta', lat: 6.9360, lng: 79.9281 },
  { name: 'Wellampitiya', lat: 6.9359, lng: 79.9161 },
  { name: 'Orugodawatta', lat: 6.9372, lng: 79.8962 },
  { name: 'Grandpass', lat: 6.9445, lng: 79.8725 },
  { name: 'Armour Street', lat: 6.9418, lng: 79.8632 },
  { name: 'Colombo (Pettah)', lat: 6.9367, lng: 79.8542 },
];

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const r = await Route.findOne({ routeId: '143' });
  if (!r || !r.pathPolyline) {
    console.error('Route 143 or its polyline not found');
    process.exit(1);
  }
  const pts = decode(r.pathPolyline);

  // Cumulative distance along the line, for ordering.
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum[i] = cum[i - 1] + haversine(pts[i - 1], pts[i]);

  const snapped = REAL_STOPS.map((s) => {
    let bestIdx = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const d = (pts[i][0] - s.lat) ** 2 + (pts[i][1] - s.lng) ** 2;
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    return { name: s.name, lat: pts[bestIdx][0], lng: pts[bestIdx][1], along: cum[bestIdx] };
  });

  // Order by true along-route distance so they line up with travel direction.
  snapped.sort((a, b) => a.along - b.along);

  const stops = snapped.map((s, order) => ({ stopName: s.name, order, lat: s.lat, lng: s.lng }));
  r.stops = stops;
  r.stopsCount = stops.length;
  r.source = stops[0].stopName;
  r.destination = stops[stops.length - 1].stopName;
  await r.save();

  console.log(`Route 143 now has ${stops.length} real stops:`);
  stops.forEach((s) => console.log(`  ${s.order} ${s.stopName}  ${s.lat.toFixed(5)},${s.lng.toFixed(5)}`));

  await mongoose.connection.close();
};

run().catch((e) => { console.error(e); process.exit(1); });
