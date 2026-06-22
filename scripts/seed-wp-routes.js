/**
 * Seed Western Province bus routes (dummy data).
 *
 * Route numbers, names and distances are derived from the
 * "Information of Bus Routes in Western Province - Year 2020" dataset.
 * Stops and coordinates are realistic dummy values for the Colombo /
 * Gampaha / Kalutara area so the live map and route list have data to show.
 *
 * Run:  node scripts/seed-wp-routes.js
 *   or:  npm run seed:wp
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Route = require('../src/models/Route');

dotenv.config();

// Realistic Sri Lankan fare: ~0.65 LKR/km for public, min 20 LKR.
function calculateFare(distance, serviceType) {
  const rate = serviceType === 'SCHOOL' ? 0.55
    : serviceType === 'UNIVERSITY' ? 0.60
    : serviceType === 'OFFICE' ? 0.75
    : 0.65;
  return Math.max(20, Math.round(distance * rate));
}

// Rough urban travel time: ~2.6 min per km.
function estimateTime(distance) {
  return Math.round(distance * 2.6);
}

// Known Western Province locations -> [lat, lng].
const PLACES = {
  'Pettah': [6.9355, 79.8487],
  'Colombo Fort': [6.9344, 79.8428],
  'Maradana': [6.9281, 79.8650],
  'Borella': [6.9148, 79.8775],
  'Town Hall': [6.9170, 79.8636],
  'Kollupitiya': [6.9101, 79.8487],
  'Bambalapitiya': [6.8896, 79.8567],
  'Wellawatte': [6.8740, 79.8610],
  'Dehiwala': [6.8517, 79.8650],
  'Mount Lavinia': [6.8389, 79.8653],
  'Ratmalana': [6.8211, 79.8867],
  'Borupana': [6.8190, 79.8800],
  'Moratuwa': [6.7730, 79.8816],
  'Panadura': [6.7133, 79.9073],
  'Narahenpita': [6.8920, 79.8770],
  'Nugegoda': [6.8649, 79.8997],
  'Kirulapone': [6.8810, 79.8790],
  'Kalubowila': [6.8590, 79.8770],
  'Maharagama': [6.8480, 79.9265],
  'Kottawa': [6.8410, 79.9650],
  'Pannipitiya': [6.8460, 79.9450],
  'Nawinna': [6.8540, 79.9070],
  'Piliyandala': [6.8016, 79.9220],
  'Kesbewa': [6.7950, 79.9390],
  'Moragahahena': [6.7700, 80.0400],
  'Horana': [6.7159, 80.0626],
  'Ingiriya': [6.7447, 80.1722],
  'Avissawella': [6.9542, 80.2092],
  'Hanwella': [6.9070, 80.0850],
  'Kaduwela': [6.9333, 79.9833],
  'Athurugiriya': [6.8753, 79.9986],
  'Malabe': [6.9060, 79.9570],
  'Rajagiriya': [6.9097, 79.8950],
  'Wellampitiya': [6.9420, 79.9180],
  'Kelaniya': [6.9553, 79.9220],
  'Peliyagoda': [6.9600, 79.8870],
  'Kiribathgoda': [6.9783, 79.9286],
  'Kadawatha': [7.0007, 79.9500],
  'Wattala': [6.9897, 79.8920],
  'Elakanda': [6.9990, 79.9050],
  'Hendala': [6.9830, 79.8870],
  'Ja-Ela': [7.0744, 79.8919],
  'Ekala': [7.1000, 79.8950],
  'Kotahena': [6.9509, 79.8636],
  'Gangaramaya (Seemamalaka)': [6.9166, 79.8560],
  'Nittambuwa': [7.1419, 80.0967],
  'Yakkala': [7.0850, 80.0350],
  'Gampaha': [7.0917, 79.9994],
  'Padukka': [6.8458, 80.0958],
};

function s(name, order) {
  const p = PLACES[name];
  if (!p) throw new Error(`Unknown place: ${name}`);
  return { stopName: name, order, lat: p[0], lng: p[1] };
}

function makeRoute(routeId, routeName, serviceType, distance, stopNames) {
  const stops = stopNames.map((n, i) => s(n, i + 1));
  return {
    routeId,
    routeName,
    source: stopNames[0],
    destination: stopNames[stopNames.length - 1],
    distance,
    estimatedTime: estimateTime(distance),
    fare: calculateFare(distance, serviceType),
    serviceType,
    stopsCount: stops.length,
    stops,
    isActive: true,
  };
}

const WP_ROUTES = [
  makeRoute('1/3', 'Avissawella - Pettah', 'PUBLIC', 60.0,
    ['Avissawella', 'Hanwella', 'Kaduwela', 'Rajagiriya', 'Borella', 'Pettah']),
  makeRoute('100', 'Panadura - Colombo', 'PUBLIC', 30.3,
    ['Panadura', 'Moratuwa', 'Ratmalana', 'Dehiwala', 'Wellawatte', 'Kollupitiya', 'Pettah']),
  makeRoute('101', 'Moratuwa - Pettah', 'PUBLIC', 22.0,
    ['Moratuwa', 'Ratmalana', 'Dehiwala', 'Wellawatte', 'Bambalapitiya', 'Pettah']),
  makeRoute('102/256', 'Kotahena - Borupana', 'PUBLIC', 34.8,
    ['Kotahena', 'Pettah', 'Kollupitiya', 'Wellawatte', 'Dehiwala', 'Borupana']),
  makeRoute('103', 'Narahenpita - Fort', 'PUBLIC', 23.0,
    ['Narahenpita', 'Town Hall', 'Borella', 'Maradana', 'Colombo Fort']),
  makeRoute('104', 'Wattala - Bambalapitiya', 'PUBLIC', 23.0,
    ['Wattala', 'Peliyagoda', 'Pettah', 'Kollupitiya', 'Bambalapitiya']),
  makeRoute('107', 'Elakanda - Fort', 'PUBLIC', 24.0,
    ['Elakanda', 'Hendala', 'Wattala', 'Peliyagoda', 'Colombo Fort']),
  makeRoute('117', 'Rathmalana - Nugegoda', 'PUBLIC', 5.0,
    ['Ratmalana', 'Kalubowila', 'Nugegoda']),
  makeRoute('119', 'Nugegoda - Maharagama', 'PUBLIC', 6.8,
    ['Nugegoda', 'Nawinna', 'Maharagama']),
  makeRoute('120', 'Horana - Pettah', 'PUBLIC', 40.7,
    ['Horana', 'Piliyandala', 'Kesbewa', 'Nugegoda', 'Kirulapone', 'Town Hall', 'Pettah']),
  makeRoute('122', 'Avissawella - Pettah', 'PUBLIC', 57.0,
    ['Avissawella', 'Hanwella', 'Kaduwela', 'Malabe', 'Rajagiriya', 'Borella', 'Pettah']),
  makeRoute('125', 'Ingiriya - Colombo', 'PUBLIC', 35.0,
    ['Ingiriya', 'Horana', 'Piliyandala', 'Maharagama', 'Nugegoda', 'Town Hall', 'Pettah']),
  makeRoute('129', 'Kottawa - Moragahahena', 'PUBLIC', 15.0,
    ['Kottawa', 'Pannipitiya', 'Piliyandala', 'Moragahahena']),
  makeRoute('135', 'Kelaniya - Kohuwala', 'PUBLIC', 17.5,
    ['Kelaniya', 'Peliyagoda', 'Pettah', 'Borella', 'Nugegoda', 'Kalubowila']),
  makeRoute('138', 'Kottawa - Pettah', 'PUBLIC', 25.0,
    ['Kottawa', 'Maharagama', 'Nugegoda', 'Kirulapone', 'Town Hall', 'Pettah']),
  makeRoute('138/4', 'Athurugiriya - Pettah', 'PUBLIC', 16.4,
    ['Athurugiriya', 'Malabe', 'Rajagiriya', 'Borella', 'Pettah']),
  makeRoute('140', 'Wellampitiya - Kollupitiya', 'PUBLIC', 25.0,
    ['Wellampitiya', 'Rajagiriya', 'Borella', 'Town Hall', 'Kollupitiya']),
  makeRoute('142', 'Moratuwa - Panadura', 'PUBLIC', 25.0,
    ['Moratuwa', 'Ratmalana', 'Panadura']),
  makeRoute('143', 'Hanwella - Pettah', 'PUBLIC', 28.0,
    ['Hanwella', 'Kaduwela', 'Rajagiriya', 'Borella', 'Maradana', 'Pettah']),
  makeRoute('144', 'Rajagiriya - Pettah', 'PUBLIC', 30.0,
    ['Rajagiriya', 'Borella', 'Town Hall', 'Maradana', 'Pettah']),
  makeRoute('147', 'Mount Lavinia - Town Hall', 'PUBLIC', 12.0,
    ['Mount Lavinia', 'Dehiwala', 'Wellawatte', 'Bambalapitiya', 'Town Hall']),
  makeRoute('150', 'Kelaniya - Gangaramaya', 'PUBLIC', 9.0,
    ['Kelaniya', 'Peliyagoda', 'Pettah', 'Gangaramaya (Seemamalaka)']),
  makeRoute('180', 'Nittambuwa - Pettah', 'PUBLIC', 43.1,
    ['Nittambuwa', 'Yakkala', 'Gampaha', 'Kadawatha', 'Kiribathgoda', 'Peliyagoda', 'Pettah']),
  makeRoute('187', 'Ja-Ela - Fort', 'PUBLIC', 18.0,
    ['Ja-Ela', 'Ekala', 'Wattala', 'Peliyagoda', 'Colombo Fort']),
  makeRoute('255', 'Kadawatha - Maharagama', 'PUBLIC', 21.0,
    ['Kadawatha', 'Kiribathgoda', 'Peliyagoda', 'Borella', 'Nugegoda', 'Maharagama']),
];

async function seed() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/trackme';
  try {
    await mongoose.connect(uri);
    console.log(`✅ Connected to MongoDB (${mongoose.connection.host})`);

    const ids = WP_ROUTES.map((r) => r.routeId);
    const removed = await Route.deleteMany({ routeId: { $in: ids } });
    console.log(`🗑️  Cleared ${removed.deletedCount} existing routes with matching IDs`);

    const created = await Route.insertMany(WP_ROUTES);
    console.log(`\n🎉 Seeded ${created.length} Western Province routes:\n`);
    created.forEach((r) => {
      console.log(`   ${r.routeId.padEnd(9)} ${r.source} → ${r.destination}  (${r.distance}km, ${r.stops.length} stops, Rs.${r.fare})`);
    });

    await mongoose.connection.close();
    console.log('\n✅ Done. Connection closed.');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
}

seed();
