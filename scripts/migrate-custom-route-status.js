// One-off migration for the custom-routes v2 status change.
//
// v1 custom routes used status PENDING_NAMING ("recorded, waiting for a name").
// v2 replaces it with RECORDING (still collecting rides) and PENDING_REVIEW (rides
// merged, waiting for the manager to confirm). Mapping:
//   PENDING_NAMING with a recorded line  -> PENDING_REVIEW
//   PENDING_NAMING with no line          -> RECORDING
//
// Idempotent. Dry-run by default; pass --apply to write.
//   node scripts/migrate-custom-route-status.js            (dry run)
//   node scripts/migrate-custom-route-status.js --apply
// Runs against whatever MONGODB_URI points at, so it works on the sandbox database
// too (use .env.sandbox / the sandbox URI).

require('dotenv').config();
const mongoose = require('mongoose');

// The model's enum no longer allows PENDING_NAMING, so this talks to the raw
// collection rather than through Mongoose validation.
const COLLECTION = 'routes';

function planStatus(route) {
  if (route.status !== 'PENDING_NAMING') return null;
  return route.pathPolyline ? 'PENDING_REVIEW' : 'RECORDING';
}

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI);
  const collection = mongoose.connection.collection(COLLECTION);

  const legacy = await collection.find({ status: 'PENDING_NAMING' }).toArray();
  console.log(`${legacy.length} route(s) with the legacy PENDING_NAMING status`);

  let changed = 0;
  for (const route of legacy) {
    const next = planStatus(route);
    console.log(`  ${route.routeId}: PENDING_NAMING -> ${next}`);
    if (apply) {
      // eslint-disable-next-line no-await-in-loop
      await collection.updateOne(
        { _id: route._id },
        { $set: { status: next, 'recording.requiredRuns': 5, 'recording.acceptedRuns': next === 'RECORDING' ? 0 : 5 } }
      );
      changed += 1;
    }
  }

  console.log(apply ? `Updated ${changed} route(s).` : 'Dry run - nothing written. Re-run with --apply.');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

module.exports = { planStatus };
