// Backfills the new Private Routes fields onto every existing visibility:'PRIVATE'
// route (today these are exclusively the custom-routes shuttle routes): isHidden:true,
// joinApprovalRequired:false, no room key. Preserves their current "never listed,
// never joinable" behavior exactly. Idempotent — safe to re-run.
//
// Usage: node scripts/migrate-private-routes.js [--dry]

require('dotenv').config();
const mongoose = require('mongoose');
const Route = require('../src/models/Route');

const DRY_RUN = process.argv.includes('--dry');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  const candidates = await Route.find({
    visibility: 'PRIVATE',
    isHidden: { $ne: true }
  }).select('routeId routeName isHidden joinApprovalRequired');

  console.log(`Found ${candidates.length} PRIVATE route(s) to migrate.`);

  if (!DRY_RUN) {
    const result = await Route.updateMany(
      { visibility: 'PRIVATE', isHidden: { $ne: true } },
      { $set: { isHidden: true, joinApprovalRequired: false } }
    );
    console.log(`Updated ${result.modifiedCount} route(s).`);
  } else {
    candidates.forEach((r) => console.log(`  [dry] ${r.routeId} — ${r.routeName}`));
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
