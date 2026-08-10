/**
 * Migration Script: canonical number plates + the unique plateKey
 *
 * Plates used to be stored however they were typed, so the same bus could sit
 * in the database twice under "PF 2343" and "PF-2343". Two changes fix that:
 *   1. Every plate is rewritten in its canonical form (CAB-1234, WP CAB-1234,
 *      62-1234).
 *   2. Every vehicle gets plateKey, the registration behind the plate with any
 *      province dropped, which carries a unique index.
 *
 * Vehicles that already collide cannot both be given the key, so they are
 * reported and left alone for a person to decide on. Nothing is deleted here.
 *
 * Safe to re-run.
 *
 * Run with: node scripts/migrate-vehicle-plates.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Vehicle = require('../src/models/Vehicle');
const { formatPlate, plateKey } = require('../src/utils/numberPlate');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGOURI;

// Groups every vehicle by the registration its plate resolves to, so a clash is
// visible before anything is written.
function groupByKey(vehicles) {
  const groups = new Map();
  for (const vehicle of vehicles) {
    const key = plateKey(vehicle.numberPlate);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(vehicle);
  }
  return groups;
}

const migrate = async () => {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected');

    const vehicles = await Vehicle.find({}).select('vehicleId numberPlate plateKey isDeleted');
    console.log(`\n🚌 ${vehicles.length} vehicle(s) found`);

    const groups = groupByKey(vehicles);
    const clashes = [...groups.entries()].filter(([, group]) => group.length > 1);

    if (clashes.length > 0) {
      console.warn('\n⚠️  These registrations are on more than one vehicle:');
      for (const [key, group] of clashes) {
        console.warn(`   ${key}`);
        group.forEach((v) => console.warn(`      ${v.vehicleId} | plate=${v.numberPlate} | deleted=${Boolean(v.isDeleted)}`));
      }
      console.warn('   Left untouched. Remove or re-plate the extras, then run this again.');
    }

    let updated = 0;
    for (const [key, group] of groups) {
      if (group.length > 1) continue;

      const [vehicle] = group;
      const canonical = formatPlate(vehicle.numberPlate) || vehicle.numberPlate;
      const needsPlate = canonical !== vehicle.numberPlate;
      const needsKey = vehicle.plateKey !== key;
      if (!needsPlate && !needsKey) continue;

      // eslint-disable-next-line no-await-in-loop
      await Vehicle.updateOne(
        { _id: vehicle._id },
        { $set: { numberPlate: canonical, plateKey: key } }
      );
      updated += 1;
      console.log(`   ${vehicle.vehicleId}: ${vehicle.numberPlate} → ${canonical} (key ${key})`);
    }

    console.log('\n🔑 Syncing indexes so plateKey is unique...');
    await Vehicle.syncIndexes();

    console.log('\n📊 Summary');
    console.log(`   • ${updated} vehicle(s) rewritten`);
    console.log(`   • ${clashes.length} clashing registration(s) left for review`);

    console.log('\n🎉 Migration completed!');
    process.exit(clashes.length > 0 ? 2 : 0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) migrate();

module.exports = { groupByKey };
