// Backfill for the custom-route feature: routes created before `visibility` /
// `status` / `origin` existed have no value for those fields, so the public routes
// API (which filters `visibility: 'PUBLIC'`) excludes them and the user app shows
// nothing. This sets the system-catalog defaults on any route missing them.
// Idempotent — safe to re-run.
//
// Usage: node scripts/backfill-route-visibility.js

require('dotenv').config();
const mongoose = require('mongoose');
const Route = require('../src/models/Route');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const orMissing = (field) => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }] });

  const vis = await Route.updateMany(orMissing('visibility'), { $set: { visibility: 'PUBLIC' } });
  const status = await Route.updateMany(orMissing('status'), { $set: { status: 'ACTIVE' } });
  const origin = await Route.updateMany(orMissing('origin'), { $set: { origin: 'SYSTEM' } });

  const publicActive = await Route.countDocuments({ isDeleted: false, isActive: true, visibility: 'PUBLIC' });
  console.log(`Backfilled visibility=${vis.modifiedCount}, status=${status.modifiedCount}, origin=${origin.modifiedCount}`);
  console.log(`Public + active routes now visible to the user app: ${publicActive}`);

  await mongoose.connection.close();
};

run().catch((e) => { console.error(e); process.exit(1); });
