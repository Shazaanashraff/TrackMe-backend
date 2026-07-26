// Seed real Sri Lankan schools / universities / offices as PIN-locked PRIVATE
// shuttle routes for the ShuttleGo (Explore) build.
//
// What it does, in order:
//   1. Backs up every PUBLIC city-bus route + all buses to scripts/data/ as JSON
//      (kept separately for future use — the public-transport / journey-planner build).
//   2. Removes those PUBLIC routes and buses from the DB (they are not part of the
//      shuttle build).
//   3. Clears any existing SCHOOL/UNIVERSITY/OFFICE routes, the Organizations, and the
//      manager accounts this script owns (so a re-run is a clean replace).
//   4. Seeds a curated set of real SL organizations. Each becomes:
//        - an Organization  (name + serviceType)
//        - a manager User   (role 'admin', scoped to that org)
//        - a PRIVATE route   whose routeName IS the organization name, listed as a
//          locked stub on Explore, unlocked with a 6-digit PIN + manager approval.
//
// The route's `routeName` is the organization name — that is what the Explore card
// shows as its title, so schools/offices read as names, not "A -> B" routes.
//
// Idempotent: safe to re-run. Usage:
//   node scripts/seed-shuttle-orgs.js            # full run
//   node scripts/seed-shuttle-orgs.js --dry      # report only, no writes
//   node scripts/seed-shuttle-orgs.js --keep-public   # don't touch public routes/buses

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Route = require('../src/models/Route');
const Bus = require('../src/models/Bus');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const { generateUniqueRoomKey } = require('../src/utils/roomKey');

const DRY_RUN = process.argv.includes('--dry');
const KEEP_PUBLIC = process.argv.includes('--keep-public');

const DATA_DIR = path.join(__dirname, 'data');
const MANAGER_PASSWORD = 'Shuttle@123'; // dev-only shared manager password
const MANAGER_EMAIL_DOMAIN = 'shuttle.trackme.lk';

// ── Curated real Sri Lankan organizations ───────────────────────────────────
// Coordinates are approximate real Western-Province locations. `source` is a
// residential catchment the shuttle collects from; `destination` is the org.
const ORGS = [
  // ── Schools ──
  {
    code: 'SCH-ROYAL', serviceType: 'SCHOOL', name: 'Royal College Colombo',
    source: 'Nugegoda', destination: 'Royal College, Colombo 07', distance: 9.4, fare: 120, estimatedTime: 35,
    stops: [
      { stopName: 'Nugegoda Junction', lat: 6.8649, lng: 79.8997 },
      { stopName: 'Kirulapone', lat: 6.8817, lng: 79.8797 },
      { stopName: 'Thimbirigasyaya', lat: 6.8951, lng: 79.8664 },
      { stopName: 'Royal College Main Gate', lat: 6.9061, lng: 79.8636 },
    ],
  },
  {
    code: 'SCH-ANANDA', serviceType: 'SCHOOL', name: 'Ananda College',
    source: 'Dehiwala', destination: 'Ananda College, Colombo 10', distance: 11.8, fare: 140, estimatedTime: 45,
    stops: [
      { stopName: 'Dehiwala Junction', lat: 6.8560, lng: 79.8650 },
      { stopName: 'Wellawatte', lat: 6.8740, lng: 79.8610 },
      { stopName: 'Bambalapitiya', lat: 6.8905, lng: 79.8565 },
      { stopName: 'Maradana', lat: 6.9287, lng: 79.8648 },
      { stopName: 'Ananda College, Maradana', lat: 6.9294, lng: 79.8709 },
    ],
  },
  {
    code: 'SCH-VISAKHA', serviceType: 'SCHOOL', name: 'Visakha Vidyalaya',
    source: 'Maharagama', destination: 'Visakha Vidyalaya, Colombo 04', distance: 12.6, fare: 150, estimatedTime: 45,
    stops: [
      { stopName: 'Maharagama', lat: 6.8480, lng: 79.9265 },
      { stopName: 'Nugegoda', lat: 6.8649, lng: 79.8997 },
      { stopName: 'Kirulapone', lat: 6.8817, lng: 79.8797 },
      { stopName: 'Visakha Vidyalaya, Vajira Road', lat: 6.8888, lng: 79.8592 },
    ],
  },
  {
    code: 'SCH-DSS', serviceType: 'SCHOOL', name: 'D. S. Senanayake College',
    source: 'Battaramulla', destination: 'D. S. Senanayake College, Colombo 08', distance: 8.1, fare: 110, estimatedTime: 30,
    stops: [
      { stopName: 'Battaramulla', lat: 6.8992, lng: 79.9186 },
      { stopName: 'Rajagiriya', lat: 6.9092, lng: 79.8946 },
      { stopName: 'Borella', lat: 6.9147, lng: 79.8778 },
      { stopName: 'D. S. Senanayake College, Gregory Road', lat: 6.9075, lng: 79.8695 },
    ],
  },
  {
    code: 'SCH-LADIES', serviceType: 'SCHOOL', name: "Ladies' College",
    source: 'Rajagiriya', destination: "Ladies' College, Colombo 04", distance: 7.5, fare: 110, estimatedTime: 30,
    stops: [
      { stopName: 'Rajagiriya', lat: 6.9092, lng: 79.8946 },
      { stopName: 'Narahenpita', lat: 6.8946, lng: 79.8776 },
      { stopName: 'Thimbirigasyaya', lat: 6.8951, lng: 79.8664 },
      { stopName: "Ladies' College, Flower Road", lat: 6.9046, lng: 79.8571 },
    ],
  },
  {
    code: 'SCH-STHOMAS', serviceType: 'SCHOOL', name: "S. Thomas' College",
    source: 'Panadura', destination: "S. Thomas' College, Mount Lavinia", distance: 14.2, fare: 160, estimatedTime: 50,
    stops: [
      { stopName: 'Panadura', lat: 6.7132, lng: 79.9026 },
      { stopName: 'Moratuwa', lat: 6.7739, lng: 79.8816 },
      { stopName: 'Ratmalana', lat: 6.8213, lng: 79.8860 },
      { stopName: "S. Thomas' College, Mount Lavinia", lat: 6.8330, lng: 79.8647 },
    ],
  },

  // ── Universities ──
  {
    code: 'UNI-COLOMBO', serviceType: 'UNIVERSITY', name: 'University of Colombo',
    source: 'Kadawatha', destination: 'University of Colombo, Colombo 03', distance: 16.5, fare: 180, estimatedTime: 55,
    stops: [
      { stopName: 'Kadawatha', lat: 7.0028, lng: 79.9500 },
      { stopName: 'Kelaniya', lat: 6.9553, lng: 79.9219 },
      { stopName: 'Maradana', lat: 6.9287, lng: 79.8648 },
      { stopName: 'University of Colombo, College House', lat: 6.9020, lng: 79.8607 },
    ],
  },
  {
    code: 'UNI-MORATUWA', serviceType: 'UNIVERSITY', name: 'University of Moratuwa',
    source: 'Colombo Fort', destination: 'University of Moratuwa, Katubedda', distance: 21.3, fare: 210, estimatedTime: 60,
    stops: [
      { stopName: 'Colombo Fort', lat: 6.9344, lng: 79.8428 },
      { stopName: 'Wellawatte', lat: 6.8740, lng: 79.8610 },
      { stopName: 'Dehiwala', lat: 6.8560, lng: 79.8650 },
      { stopName: 'Moratuwa', lat: 6.7739, lng: 79.8816 },
      { stopName: 'University of Moratuwa, Katubedda', lat: 6.7959, lng: 79.9009 },
    ],
  },
  {
    code: 'UNI-JPURA', serviceType: 'UNIVERSITY', name: 'University of Sri Jayewardenepura',
    source: 'Kottawa', destination: 'University of Sri Jayewardenepura, Nugegoda', distance: 8.9, fare: 120, estimatedTime: 35,
    stops: [
      { stopName: 'Kottawa', lat: 6.8410, lng: 79.9650 },
      { stopName: 'Maharagama', lat: 6.8480, lng: 79.9265 },
      { stopName: 'Nugegoda', lat: 6.8649, lng: 79.8997 },
      { stopName: 'University of Sri Jayewardenepura, Gangodawila', lat: 6.8517, lng: 79.9016 },
    ],
  },
  {
    code: 'UNI-SLIIT', serviceType: 'UNIVERSITY', name: 'SLIIT Malabe Campus',
    source: 'Borella', destination: 'SLIIT, Malabe', distance: 15.7, fare: 180, estimatedTime: 50,
    stops: [
      { stopName: 'Borella', lat: 6.9147, lng: 79.8778 },
      { stopName: 'Rajagiriya', lat: 6.9092, lng: 79.8946 },
      { stopName: 'Malabe Town', lat: 6.9046, lng: 79.9573 },
      { stopName: 'SLIIT, New Kandy Road', lat: 6.9147, lng: 79.9725 },
    ],
  },

  // ── Offices (real SL companies) ──
  {
    code: 'OFF-JKH', serviceType: 'OFFICE', name: 'John Keells Holdings',
    source: 'Maharagama', destination: 'John Keells, Colombo 02', distance: 13.4, fare: 160, estimatedTime: 50,
    stops: [
      { stopName: 'Maharagama', lat: 6.8480, lng: 79.9265 },
      { stopName: 'Nugegoda', lat: 6.8649, lng: 79.8997 },
      { stopName: 'Town Hall', lat: 6.9165, lng: 79.8632 },
      { stopName: 'Union Place', lat: 6.9214, lng: 79.8558 },
      { stopName: 'John Keells, Glennie Street', lat: 6.9269, lng: 79.8489 },
    ],
  },
  {
    code: 'OFF-MAS', serviceType: 'OFFICE', name: 'MAS Holdings',
    source: 'Kelaniya', destination: 'MAS Holdings, Biyagama', distance: 10.1, fare: 130, estimatedTime: 40,
    stops: [
      { stopName: 'Kelaniya', lat: 6.9553, lng: 79.9219 },
      { stopName: 'Kadawatha', lat: 7.0028, lng: 79.9500 },
      { stopName: 'Biyagama Junction', lat: 6.9497, lng: 79.9853 },
      { stopName: 'MAS Fabric Park, Biyagama', lat: 6.9603, lng: 79.9931 },
    ],
  },
  {
    code: 'OFF-DIALOG', serviceType: 'OFFICE', name: 'Dialog Axiata',
    source: 'Kaduwela', destination: 'Dialog Axiata, Colombo 03', distance: 17.8, fare: 190, estimatedTime: 55,
    stops: [
      { stopName: 'Kaduwela', lat: 6.9333, lng: 79.9847 },
      { stopName: 'Battaramulla', lat: 6.8992, lng: 79.9186 },
      { stopName: 'Rajagiriya', lat: 6.9092, lng: 79.8946 },
      { stopName: 'Dialog Axiata, Union Place', lat: 6.9200, lng: 79.8560 },
    ],
  },
  {
    code: 'OFF-COMBANK', serviceType: 'OFFICE', name: 'Commercial Bank of Ceylon',
    source: 'Moratuwa', destination: 'Commercial Bank HQ, Colombo 02', distance: 19.6, fare: 200, estimatedTime: 60,
    stops: [
      { stopName: 'Moratuwa', lat: 6.7739, lng: 79.8816 },
      { stopName: 'Dehiwala', lat: 6.8560, lng: 79.8650 },
      { stopName: 'Bambalapitiya', lat: 6.8905, lng: 79.8565 },
      { stopName: 'Commercial Bank, Bristol Street', lat: 6.9331, lng: 79.8446 },
    ],
  },
  {
    code: 'OFF-WSO2', serviceType: 'OFFICE', name: 'WSO2',
    source: 'Kottawa', destination: 'WSO2, Colombo 03', distance: 14.9, fare: 170, estimatedTime: 50,
    stops: [
      { stopName: 'Kottawa', lat: 6.8410, lng: 79.9650 },
      { stopName: 'Nugegoda', lat: 6.8649, lng: 79.8997 },
      { stopName: 'Bambalapitiya', lat: 6.8905, lng: 79.8565 },
      { stopName: 'WSO2, Bauddhaloka Mawatha', lat: 6.8996, lng: 79.8611 },
    ],
  },
  {
    code: 'OFF-BRANDIX', serviceType: 'OFFICE', name: 'Brandix Lanka',
    source: 'Ja-Ela', destination: 'Brandix, Colombo 02', distance: 18.2, fare: 190, estimatedTime: 55,
    stops: [
      { stopName: 'Ja-Ela', lat: 7.0744, lng: 79.8919 },
      { stopName: 'Wattala', lat: 6.9897, lng: 79.8919 },
      { stopName: 'Colombo Fort', lat: 6.9344, lng: 79.8428 },
      { stopName: 'Brandix, Punchi Borella', lat: 6.9280, lng: 79.8710 },
    ],
  },
];

function slug(code) {
  return code.toLowerCase().replace(/[^a-z0-9]+/g, '.');
}

function writeBackup(name, docs) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file, JSON.stringify(docs, null, 2));
  return file;
}

async function roomKeyHashExists(hash) {
  const existing = await Route.findOne({ 'roomKey.lookupHash': hash }).select('_id');
  return !!existing;
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to ${process.env.MONGODB_URI}\n`);

  // ── 1 + 2. Back up and remove PUBLIC city routes + buses ──────────────────
  if (!KEEP_PUBLIC) {
    const publicRoutes = await Route.find({ serviceType: 'PUBLIC' }).lean();
    const buses = await Bus.find({}).lean();
    console.log(`Public city routes: ${publicRoutes.length}   Buses: ${buses.length}`);

    if (!DRY_RUN) {
      const rf = writeBackup('public-city-routes-backup.json', publicRoutes);
      const bf = writeBackup('buses-backup.json', buses);
      console.log(`  backed up routes -> ${path.relative(process.cwd(), rf)}`);
      console.log(`  backed up buses  -> ${path.relative(process.cwd(), bf)}`);

      const dr = await Route.deleteMany({ serviceType: 'PUBLIC' });
      const dbu = await Bus.deleteMany({});
      console.log(`  removed ${dr.deletedCount} public routes, ${dbu.deletedCount} buses from TrackMe`);
    }
  } else {
    console.log('--keep-public: leaving public routes & buses untouched');
  }

  // ── 3. Clear existing shuttle data (clean replace) ────────────────────────
  const managerEmails = ORGS.map((o) => `manager.${slug(o.code)}@${MANAGER_EMAIL_DOMAIN}`);
  if (!DRY_RUN) {
    const dRoutes = await Route.deleteMany({ serviceType: { $in: ['SCHOOL', 'UNIVERSITY', 'OFFICE'] } });
    const dOrgs = await Organization.deleteMany({});
    const dMgrs = await User.deleteMany({ email: { $in: managerEmails } });
    console.log(`\nCleared ${dRoutes.deletedCount} old shuttle routes, ${dOrgs.deletedCount} orgs, ${dMgrs.deletedCount} seeded managers`);
  }

  // ── 4. Seed the curated organizations ─────────────────────────────────────
  console.log('\nSeeding organizations:\n');
  const summary = [];

  for (const org of ORGS) {
    if (DRY_RUN) {
      console.log(`  [dry] ${org.serviceType.padEnd(10)} ${org.name}`);
      continue;
    }

    // Organization
    const orgDoc = await Organization.create({
      name: org.name,
      serviceType: org.serviceType,
      isActive: true,
    });

    // Manager (role 'admin', scoped to this org)
    const email = `manager.${slug(org.code)}@${MANAGER_EMAIL_DOMAIN}`;
    const manager = await User.create({
      name: `${org.name} Manager`,
      email,
      password: MANAGER_PASSWORD, // hashed by User pre-save
      role: 'admin',
      serviceType: org.serviceType,
      organization: orgDoc._id,
      isEmailVerified: true,
      isActive: true,
    });

    // PIN-locked PRIVATE route — routeName IS the organization name
    const generated = await generateUniqueRoomKey(roomKeyHashExists);
    const stops = org.stops.map((s, i) => ({ ...s, order: i }));

    await Route.create({
      routeId: org.code,
      routeName: org.name,
      source: org.source,
      destination: org.destination,
      distance: org.distance,
      estimatedTime: org.estimatedTime,
      fare: org.fare,
      serviceType: org.serviceType,
      stops,
      stopsCount: stops.length,
      visibility: 'PRIVATE',
      isHidden: false,            // listed on Explore as a locked stub
      joinApprovalRequired: true, // PIN + manager approval
      managerId: manager._id,
      createdBy: manager._id,
      origin: 'SYSTEM',
      status: 'ACTIVE',
      isActive: true,
      roomKey: {
        ciphertext: generated.ciphertext,
        iv: generated.iv,
        authTag: generated.authTag,
        lookupHash: generated.lookupHash,
        updatedAt: new Date(),
        updatedBy: manager._id,
      },
    });

    summary.push({ type: org.serviceType, name: org.name, pin: generated.code, manager: email });
    console.log(`  ${org.serviceType.padEnd(10)} ${org.name.padEnd(38)} PIN ${generated.code}`);
  }

  if (!DRY_RUN && summary.length) {
    writeBackup('shuttle-orgs-pins.json', summary);
    console.log(`\nPINs + manager logins saved to scripts/data/shuttle-orgs-pins.json`);
    console.log(`Manager password (all): ${MANAGER_PASSWORD}`);
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
