/**
 * Replace the route catalog with the consolidated national Sri Lanka route set.
 *
 * Source: scripts/data/sl-routes-seed.json — built from official data:
 *   NTC inter-provincial annexures + NTC valid-permit register (national) +
 *   Central Province (CPTSA) + Southern Province (SPRPTA) + Western Province (RPTA-WP).
 * De-duplicated on (route number, origin, destination); route numbers normalised.
 *
 * This DELETES all existing routes and inserts the catalog. Buses/live-tracking are
 * handled separately (the live-tracking feature is being re-implemented).
 *
 * Run:  node scripts/seed-all-sl-routes.js
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Route = require('../src/models/Route');

dotenv.config();

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/trackme';
  const file = path.join(__dirname, 'data', 'sl-routes-seed.json');
  const routes = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Loaded ${routes.length} routes from ${path.basename(file)}`);

  await mongoose.connect(uri);
  console.log(`Connected to MongoDB (${mongoose.connection.host})`);

  const before = await Route.countDocuments();
  const del = await Route.deleteMany({});
  console.log(`Deleted ${del.deletedCount} existing routes (was ${before}).`);

  // Insert in chunks; ordered:false so one bad row can't abort the whole batch.
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < routes.length; i += CHUNK) {
    const slice = routes.slice(i, i + CHUNK);
    const res = await Route.insertMany(slice, { ordered: false });
    inserted += res.length;
    console.log(`  inserted ${inserted}/${routes.length}`);
  }

  const total = await Route.countDocuments();
  console.log(`Done. Routes in DB: ${total}`);
  await mongoose.connection.close();
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
