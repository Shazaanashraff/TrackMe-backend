/**
 * Backfill RETURN-direction geometry for routes that already have an outbound line.
 *
 * For each route with pathPolyline (but no pathPolylineReturn), ask Google Transit for
 * the reverse trip (destination -> origin), match the same line number, and store that
 * leg's polyline in pathPolylineReturn. Many routes take a slightly different road on
 * the way back, so drawing both gives the full there-and-back shape. If the return
 * geometry is effectively identical to the outbound, we skip storing it (no redundant
 * overlapping line).
 *
 * Same quota discipline as backfill-route-geometry.js: paced, per-minute 429 waits,
 * per-day 429 aborts (no retry storm).
 *
 * Run:  node scripts/backfill-return-geometry.js
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Route = require('../src/models/Route');

dotenv.config();

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const normLine = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
const baseNum = (s) => normLine(s).split('#')[0];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function transitLegs(from, to, key) {
  const bodyFor = (extra) => ({
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode: 'TRANSIT',
    computeAlternativeRoutes: true,
    transitPreferences: { allowedTravelModes: ['BUS'], ...extra },
  });
  const variants = [bodyFor({}), bodyFor({ routingPreference: 'LESS_WALKING' })];
  const legs = [];
  for (const body of variants) {
    for (let attempt = 0; ; attempt += 1) {
      let r;
      try {
        r = await fetch(ROUTES_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask':
              'routes.legs.steps.transitDetails.transitLine.nameShort,routes.legs.steps.transitDetails.transitLine.name,routes.legs.steps.polyline.encodedPolyline',
          },
          body: JSON.stringify(body),
        });
      } catch { break; }
      if (r.status === 429) {
        const msg = await r.text();
        if (/per\s*-?\s*day/i.test(msg)) { const e = new Error('daily quota'); e.quota = true; throw e; }
        if (attempt < 2) { await sleep(62000); continue; }
        break;
      }
      if (!r.ok) break;
      for (const rt of (await r.json()).routes || []) {
        for (const leg of rt.legs || []) {
          for (const st of leg.steps || []) {
            if (st.transitDetails && st.polyline?.encodedPolyline) {
              legs.push({
                line: st.transitDetails.transitLine?.nameShort || st.transitDetails.transitLine?.name || '',
                polyline: st.polyline.encodedPolyline,
              });
            }
          }
        }
      }
      break;
    }
  }
  return legs;
}

async function main() {
  const key = process.env.GOOGLE_ROUTES_KEY || process.env.GOOGLE_PLACES_KEY;
  if (!key) throw new Error('GOOGLE_ROUTES_KEY / GOOGLE_PLACES_KEY missing');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackme');

  const targets = (await Route.find({
    pathPolyline: { $type: 'string', $regex: /.+/ },
    $or: [{ pathPolylineReturn: '' }, { pathPolylineReturn: { $exists: false } }],
  }).select('routeId stops pathPolyline pathPolylineReturn'));
  console.log(`Routes needing a return path: ${targets.length}`);

  let filled = 0, skipped = 0;
  try {
    for (const r of targets) {
      const s = (r.stops || []).filter((x) => typeof x.lat === 'number');
      if (s.length < 2) continue;
      // reverse trip: last stop -> first stop
      const legs = await transitLegs(s[s.length - 1], s[0], key);
      const want = baseNum(r.routeId);
      let hit = legs.find((l) => normLine(l.line) === normLine(r.routeId));
      if (!hit) hit = legs.find((l) => baseNum(l.line) === want);
      if (hit && hit.polyline && hit.polyline !== r.pathPolyline) {
        r.pathPolylineReturn = hit.polyline;
        await r.save();
        filled += 1;
        console.log(`  ${r.routeId}: return path stored`);
      } else if (hit) {
        skipped += 1; // identical to outbound — nothing to add
      }
      await sleep(1500);
    }
  } catch (err) {
    if (err.quota) console.warn(`\n⚠ ABORTED — daily quota exhausted. Stored ${filled} return paths this run.`);
    else throw err;
  }
  console.log(`Done. Return paths stored: ${filled} (identical/skipped: ${skipped}).`);
  await mongoose.connection.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
