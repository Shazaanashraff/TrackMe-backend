// Sets Route.simBusCount for the curated 21 Western-Province demo routes. These are
// approximate real-world fleet sizes (both directions combined) used to drive the
// client-side deterministic bus simulation on the live map. Idempotent — re-running
// just re-applies the same values. Any route not listed keeps simBusCount = 0
// (no simulation).
//
// Usage: node scripts/set-sim-bus-counts.js

require('dotenv').config();
const mongoose = require('mongoose');
const Route = require('../src/models/Route');

// routeId -> approximate total buses operating on the route (both directions).
const COUNTS = {
  '138': 300,
  '100': 200,
  '120': 200,
  '101': 160,
  '255': 110,
  '143': 90,
  '125': 60,
  '154': 60,
  '170': 60,
  '103': 45,
  '117': 45,
  '119': 45,
  '144': 45,
  '107': 30,
  '135': 30,
  '140': 30,
  '188': 30,
  '261': 30,
  '124': 25,
  '129': 25,
  '141': 22
};

const run = async () => {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  let updated = 0;
  const missing = [];
  for (const [routeId, count] of Object.entries(COUNTS)) {
    const res = await Route.updateOne(
      { routeId, isDeleted: false },
      { $set: { simBusCount: count } }
    );
    if (res.matchedCount === 0) {
      missing.push(routeId);
    } else {
      updated += 1;
      console.log(`  ${routeId.padEnd(5)} -> ${count} buses`);
    }
  }

  console.log(`\nDone. ${updated}/${Object.keys(COUNTS).length} routes updated.`);
  if (missing.length) console.log('Not found (skipped):', missing.join(', '));

  await mongoose.connection.close();
};

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
