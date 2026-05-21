const mongoose = require('mongoose');
const Route = require('../src/models/Route');
const dotenv = require('dotenv');

dotenv.config();

// Calculate realistic Sri Lankan bus fare based on distance
// Rates: ~0.50-0.80 LKR per km depending on service type
function calculateFare(distance, serviceType) {
  let ratePerKm = 0.65; // Default rate for PUBLIC buses
  
  if (serviceType === 'SCHOOL') {
    ratePerKm = 0.55; // School buses cheaper
  } else if (serviceType === 'UNIVERSITY') {
    ratePerKm = 0.60; // University buses slightly cheaper
  } else if (serviceType === 'OFFICE') {
    ratePerKm = 0.75; // Office/private shuttles more expensive
  }
  
  const baseFare = Math.round(distance * ratePerKm);
  return baseFare >= 20 ? baseFare : 20; // Minimum 20 LKR
}

const SLK_BUS_ROUTES = [
  {
    routeId: '100',
    routeName: 'Colombo - Kandy Express',
    source: 'Colombo Fort',
    destination: 'Kandy Central',
    distance: 115,
    estimatedTime: 180,
    fare: 75,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Colombo Fort', lat: 6.9271, lng: 79.8353, order: 1 },
      { stopName: 'Maharagama Junction', lat: 6.8167, lng: 79.8667, order: 2 },
      { stopName: 'Kelaniya Temple Junction', lat: 6.9289, lng: 80.1281, order: 3 },
      { stopName: 'Ambepussa Junction', lat: 7.1122, lng: 80.2789, order: 4 },
      { stopName: 'Rambukkana', lat: 7.3056, lng: 80.3817, order: 5 },
      { stopName: 'Kandy Central (Goods Shed)', lat: 7.2906, lng: 80.6328, order: 6 }
    ]
  },
  {
    routeId: '101',
    routeName: 'Colombo - Galle Highway',
    source: 'Colombo Fort',
    destination: 'Galle',
    distance: 119,
    estimatedTime: 180,
    fare: 77,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Colombo Fort', lat: 6.9271, lng: 79.8353, order: 1 },
      { stopName: 'Wellawatta Junction', lat: 6.8722, lng: 79.8467, order: 2 },
      { stopName: 'Mount Lavinia Hotel', lat: 6.8455, lng: 79.8631, order: 3 },
      { stopName: 'Moratuwa Junction', lat: 6.8019, lng: 79.8767, order: 4 },
      { stopName: 'Panadura', lat: 6.7313, lng: 79.8917, order: 5 },
      { stopName: 'Matara Junction', lat: 5.9497, lng: 80.5378, order: 6 },
      { stopName: 'Galle Fort', lat: 6.0535, lng: 80.2169, order: 7 }
    ]
  },
  {
    routeId: '102',
    routeName: 'Colombo - Negombo Coastal',
    source: 'Colombo Fort',
    destination: 'Negombo Bus Stand',
    distance: 37,
    estimatedTime: 90,
    fare: 24,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Colombo Fort', lat: 6.9271, lng: 79.8353, order: 1 },
      { stopName: 'Colombo Harbour', lat: 6.9363, lng: 79.8317, order: 2 },
      { stopName: 'Ragama Junction', lat: 6.9711, lng: 79.9058, order: 3 },
      { stopName: 'Wattala', lat: 6.9839, lng: 79.9242, order: 4 },
      { stopName: 'Negombo Bus Stand', lat: 7.2093, lng: 79.8431, order: 5 }
    ]
  },
  {
    routeId: '103',
    routeName: 'Colombo - Anuradhapura Heritage',
    source: 'Colombo Main Bus Stand',
    destination: 'Anuradhapura Bus Terminus',
    distance: 205,
    estimatedTime: 330,
    fare: 133,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Colombo Main Bus Stand', lat: 6.9365, lng: 79.8578, order: 1 },
      { stopName: 'Kurunegala Junction', lat: 7.4870, lng: 80.6344, order: 2 },
      { stopName: 'Dambulla', lat: 7.8667, lng: 80.6500, order: 3 },
      { stopName: 'Matale', lat: 7.6158, lng: 80.7789, order: 4 },
      { stopName: 'Anuradhapura Bus Terminus', lat: 8.3369, lng: 80.4133, order: 5 }
    ]
  },
  {
    routeId: '104',
    routeName: 'Kandy - Nuwara Eliya Hill Country',
    source: 'Kandy Central',
    destination: 'Nuwara Eliya Market',
    distance: 58,
    estimatedTime: 150,
    fare: 38,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Kandy Central', lat: 7.2906, lng: 80.6328, order: 1 },
      { stopName: 'Peradeniya Junction', lat: 7.2513, lng: 80.7733, order: 2 },
      { stopName: 'Gampola', lat: 7.1797, lng: 80.7833, order: 3 },
      { stopName: 'Nawalapitiya', lat: 7.0494, lng: 80.8222, order: 4 },
      { stopName: 'Nuwara Eliya Market', lat: 6.9497, lng: 80.7834, order: 5 }
    ]
  },
  {
    routeId: '105',
    routeName: 'Galle - Matara South Coast',
    source: 'Galle Fort',
    destination: 'Matara Bus Stand',
    distance: 42,
    estimatedTime: 75,
    fare: 27,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Galle Fort', lat: 6.0535, lng: 80.2169, order: 1 },
      { stopName: 'Unawatuna Beach', lat: 6.0244, lng: 80.3453, order: 2 },
      { stopName: 'Mirissa', lat: 5.9497, lng: 80.4828, order: 3 },
      { stopName: 'Polhena', lat: 5.9650, lng: 80.5386, order: 4 },
      { stopName: 'Matara Bus Stand', lat: 5.9497, lng: 80.5378, order: 5 }
    ]
  },
  {
    routeId: '106',
    routeName: 'Colombo - Jaffna Northern Main',
    source: 'Colombo Main Bus Stand',
    destination: 'Jaffna Market',
    distance: 401,
    estimatedTime: 600,
    fare: 261,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Colombo Main Bus Stand', lat: 6.9365, lng: 79.8578, order: 1 },
      { stopName: 'Kurunegala Junction', lat: 7.4870, lng: 80.6344, order: 2 },
      { stopName: 'Puttalam', lat: 8.0333, lng: 79.8333, order: 3 },
      { stopName: 'Mullaitivu', lat: 8.7053, lng: 81.5200, order: 4 },
      { stopName: 'Vavuniya Junction', lat: 8.7564, lng: 80.8119, order: 5 },
      { stopName: 'Jaffna Market', lat: 9.6615, lng: 80.7845, order: 6 }
    ]
  },
  {
    routeId: '107',
    routeName: 'Trincomalee - Batticaloa East Coast',
    source: 'Trincomalee Central Bus Stand',
    destination: 'Batticaloa Bus Stand',
    distance: 97,
    estimatedTime: 180,
    fare: 63,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Trincomalee Central Bus Stand', lat: 8.5711, lng: 81.2344, order: 1 },
      { stopName: 'Kuchchaveli', lat: 8.5889, lng: 81.3167, order: 2 },
      { stopName: 'Nilaveli Beach', lat: 8.6214, lng: 81.2653, order: 3 },
      { stopName: 'Batticaloa Bus Stand', lat: 7.7086, lng: 81.6944, order: 4 }
    ]
  },
  {
    routeId: '108',
    routeName: 'Colombo - Negombo Private Shuttle',
    source: 'Colombo Fort',
    destination: 'Negombo Bus Stand',
    distance: 37,
    estimatedTime: 60,
    fare: 28,
    serviceType: 'OFFICE',
    stops: [
      { stopName: 'Colombo Fort', lat: 6.9271, lng: 79.8353, order: 1 },
      { stopName: 'Colombo Harbour', lat: 6.9363, lng: 79.8317, order: 2 },
      { stopName: 'Negombo Bus Stand', lat: 7.2093, lng: 79.8431, order: 3 }
    ]
  },
  {
    routeId: '109',
    routeName: 'Colombo - Kandy University Shuttle',
    source: 'Colombo University Law',
    destination: 'Kandy University',
    distance: 115,
    estimatedTime: 150,
    fare: 69,
    serviceType: 'UNIVERSITY',
    stops: [
      { stopName: 'Colombo University Law', lat: 6.9173, lng: 79.8758, order: 1 },
      { stopName: 'Kelaniya University', lat: 6.9289, lng: 80.1281, order: 2 },
      { stopName: 'Peradeniya University', lat: 7.2513, lng: 80.7733, order: 3 },
      { stopName: 'Kandy University', lat: 7.2906, lng: 80.6328, order: 4 }
    ]
  },
  {
    routeId: '110',
    routeName: 'Colombo - Bambalapitiya School Transport',
    source: 'Colombo Central',
    destination: 'Bambalapitiya School',
    distance: 8,
    estimatedTime: 30,
    fare: 20,
    serviceType: 'SCHOOL',
    stops: [
      { stopName: 'Colombo Central', lat: 6.9300, lng: 79.8467, order: 1 },
      { stopName: 'Galle Face', lat: 6.9327, lng: 79.8445, order: 2 },
      { stopName: 'Bambalapitiya Bus Stop', lat: 6.8833, lng: 79.8600, order: 3 },
      { stopName: 'Bambalapitiya School', lat: 6.8822, lng: 79.8578, order: 4 }
    ]
  },
  {
    routeId: '111',
    routeName: 'Kandy - Badulla Mountain Express',
    source: 'Kandy Central',
    destination: 'Badulla Bazaar',
    distance: 82,
    estimatedTime: 180,
    fare: 53,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Kandy Central', lat: 7.2906, lng: 80.6328, order: 1 },
      { stopName: 'Peradeniya', lat: 7.2513, lng: 80.7733, order: 2 },
      { stopName: 'Gampola', lat: 7.1797, lng: 80.7833, order: 3 },
      { stopName: 'Nawalapitiya', lat: 7.0494, lng: 80.8222, order: 4 },
      { stopName: 'Nuwara Eliya', lat: 6.9497, lng: 80.7834, order: 5 },
      { stopName: 'Badulla Bazaar', lat: 6.9903, lng: 81.2717, order: 6 }
    ]
  },
  {
    routeId: '112',
    routeName: 'Colombo - Matara Southern Express',
    source: 'Colombo Fort',
    destination: 'Matara Bus Stand',
    distance: 157,
    estimatedTime: 210,
    fare: 102,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Colombo Fort', lat: 6.9271, lng: 79.8353, order: 1 },
      { stopName: 'Moratuwa', lat: 6.8019, lng: 79.8767, order: 2 },
      { stopName: 'Panadura', lat: 6.7313, lng: 79.8917, order: 3 },
      { stopName: 'Kalutara Junction', lat: 6.5867, lng: 79.9542, order: 4 },
      { stopName: 'Matara Bus Stand', lat: 5.9497, lng: 80.5378, order: 5 }
    ]
  },
  {
    routeId: '113',
    routeName: 'Kurunegala - Puttalam West Route',
    source: 'Kurunegala Junction',
    destination: 'Puttalam Bus Stand',
    distance: 68,
    estimatedTime: 120,
    fare: 44,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Kurunegala Junction', lat: 7.4870, lng: 80.6344, order: 1 },
      { stopName: 'Bingiriya Junction', lat: 7.6667, lng: 80.4833, order: 2 },
      { stopName: 'Chilaw', lat: 7.5839, lng: 79.7931, order: 3 },
      { stopName: 'Puttalam Bus Stand', lat: 8.0333, lng: 79.8333, order: 4 }
    ]
  },
  {
    routeId: '114',
    routeName: 'Galle - Hikkaduwa Beach Shuttle',
    source: 'Galle Fort',
    destination: 'Hikkaduwa Main Road',
    distance: 29,
    estimatedTime: 45,
    fare: 20,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Galle Fort', lat: 6.0535, lng: 80.2169, order: 1 },
      { stopName: 'Ahangama', lat: 6.0753, lng: 80.3117, order: 2 },
      { stopName: 'Neluwa', lat: 6.1219, lng: 80.3522, order: 3 },
      { stopName: 'Hikkaduwa Main Road', lat: 6.1411, lng: 80.3914, order: 4 }
    ]
  },
  {
    routeId: '115',
    routeName: 'Colombo - Ratnapura Gem Route',
    source: 'Colombo Main Bus Stand',
    destination: 'Ratnapura Bus Stand',
    distance: 101,
    estimatedTime: 180,
    fare: 66,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Colombo Main Bus Stand', lat: 6.9365, lng: 79.8578, order: 1 },
      { stopName: 'Dehiwala Junction', lat: 6.8372, lng: 79.8658, order: 2 },
      { stopName: 'Kalutara Junction', lat: 6.5867, lng: 79.9542, order: 3 },
      { stopName: 'Avissawella', lat: 6.6294, lng: 80.6442, order: 4 },
      { stopName: 'Ratnapura Bus Stand', lat: 6.7128, lng: 80.3942, order: 5 }
    ]
  }
];

async function seedRoutes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bus-tracking');

    console.log('✅ Connected to MongoDB');
    
    // Delete existing Sri Lankan routes to avoid duplicates
    const routeIds = SLK_BUS_ROUTES.map(r => r.routeId);
    await Route.deleteMany({ routeId: { $in: routeIds } });
    console.log('🗑️  Cleared existing routes');
    
    const createdRoutes = await Route.insertMany(SLK_BUS_ROUTES);
    console.log(`\n🎉 Successfully seeded ${createdRoutes.length} Sri Lankan bus routes into the system\n`);

    createdRoutes.forEach((route) => {
      console.log(
        `   Route ${route.routeId}: ${route.source} → ${route.destination} (${route.distance}km, ${route.stops.length} stops)`
      );
    });

    console.log('\n✅ Database connection closed');
    await mongoose.connection.close();
  } catch (error) {
    console.error('❌ Error seeding routes:', error.message);
    process.exit(1);
  }
}

seedRoutes();
