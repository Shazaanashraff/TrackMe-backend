/**
 * Backfill accurate road geometry for Western-Province-scoped routes.
 *
 * For each WP route (both endpoints inside the WP box) we ask Google Transit which
 * buses serve origin->destination, find the leg whose line number matches the route
 * number, and store THAT bus's real encoded polyline on route.pathPolyline. This is
 * genuine geometry (not a geocoded guess). Routes Google doesn't cover are left
 * empty (no invented line). Re-runnable: only fills routes that are still empty, so
 * repeated passes catch Google's non-deterministic matches.
 *
 * Run:  node scripts/backfill-route-geometry.js
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Route = require('../src/models/Route');

dotenv.config();

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const WP = { latMin: 6.4, latMax: 7.35, lngMin: 79.75, lngMax: 80.4 };
const inWP = (s) => s && s.lat >= WP.latMin && s.lat <= WP.latMax && s.lng >= WP.lngMin && s.lng <= WP.lngMax;
const normLine = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
const baseNum = (s) => normLine(s).split('#')[0];

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
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
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
      } catch { break; } // network error — skip this variant

      if (r.status === 429) {
        const msg = await r.text();
        // PER-DAY exhaustion is permanent for today -> abort the whole run.
        if (/per\s*-?\s*day/i.test(msg)) {
          const err = new Error(`Routes API daily quota exhausted: ${msg.slice(0, 160)}`);
          err.quota = true;
          throw err;
        }
        // PER-MINUTE (transient) -> wait out the window and retry, capped at 2 tries.
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
      break; // success for this variant
    }
  }
  return legs;
}

async function main() {
  const key = process.env.GOOGLE_ROUTES_KEY || process.env.GOOGLE_PLACES_KEY;
  if (!key) throw new Error('GOOGLE_ROUTES_KEY / GOOGLE_PLACES_KEY missing');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trackme');

  const MIN_STOPS = Number(process.env.MIN_STOPS || 2); // set MIN_STOPS=3 for real corridors only
  const all = await Route.find({ isDeleted: false }).select('routeId stops pathPolyline');
  const targets = all.filter((r) => {
    const s = (r.stops || []).filter((x) => typeof x.lat === 'number' && typeof x.lng === 'number');
    return s.length >= MIN_STOPS && inWP(s[0]) && inWP(s[s.length - 1]) && !r.pathPolyline;
  });
  // Optional LIMIT to process only N routes per run (batch-wise, gentle on the API).
  const limit = Number(process.env.LIMIT || 0);
  const work = limit > 0 ? targets.slice(0, limit) : targets;
  console.log(`WP routes needing geometry: ${targets.length}${limit ? ` (this batch: ${work.length})` : ''}`);

  let filled = 0;
  const CONC = 1;                 // sequential — gentlest on the per-minute limit
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  try {
    for (let i = 0; i < work.length; i += CONC) {
      const batch = work.slice(i, i + CONC);
      await Promise.all(batch.map(async (r) => {
        const s = r.stops.filter((x) => typeof x.lat === 'number');
        const legs = await transitLegs(s[0], s[s.length - 1], key);
        const want = baseNum(r.routeId);
        let hit = legs.find((l) => normLine(l.line) === normLine(r.routeId));
        if (!hit) hit = legs.find((l) => baseNum(l.line) === want);
        if (hit) {
          r.pathPolyline = hit.polyline;
          await r.save();
          filled += 1;
        }
      }));
      if (i % 10 === 0) console.log(`  ${Math.min(i + CONC, work.length)}/${work.length} processed, ${filled} matched`);
      await sleep(1500); // ~2 calls/route + gap => well under the per-minute limit
    }
  } catch (err) {
    if (err.quota) {
      console.warn(`\n⚠ ABORTED — daily Routes API quota exhausted. Filled ${filled} this run.`);
      console.warn('  Re-run when the quota resets (daily) or after raising it. No calls retried.');
    } else {
      throw err;
    }
  }

  const withGeo = await Route.countDocuments({ pathPolyline: { $exists: true, $ne: '' } });
  console.log(`Done. Filled ${filled}. Routes with stored geometry: ${withGeo}`);
  await mongoose.connection.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
