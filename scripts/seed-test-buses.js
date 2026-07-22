const mongoose = require('mongoose');
const Bus = require('../src/models/Bus');
const Driver = require('../src/models/Driver');
const dotenv = require('dotenv');

dotenv.config();

// Test driver data - we'll create these first
const TEST_DRIVERS = [
  { email: 'driver.slt100@bus.com', name: 'Drivers Team 100', phone: '+94701234567', password: 'TestDriver@123' },
  { email: 'driver.slt101@bus.com', name: 'Drivers Team 101', phone: '+94701234568', password: 'TestDriver@123' },
  { email: 'driver.slt102@bus.com', name: 'Drivers Team 102', phone: '+94701234569', password: 'TestDriver@123' },
  { email: 'driver.slt103@bus.com', name: 'Drivers Team 103', phone: '+94701234570', password: 'TestDriver@123' },
  { email: 'driver.slt104@bus.com', name: 'Drivers Team 104', phone: '+94701234571', password: 'TestDriver@123' },
  { email: 'driver.slt105@bus.com', name: 'Drivers Team 105', phone: '+94701234572', password: 'TestDriver@123' },
  { email: 'driver.slt106@bus.com', name: 'Drivers Team 106', phone: '+94701234573', password: 'TestDriver@123' },
  { email: 'driver.slt107@bus.com', name: 'Drivers Team 107', phone: '+94701234574', password: 'TestDriver@123' },
  { email: 'driver.slt108@bus.com', name: 'Drivers Team 108', phone: '+94701234575', password: 'TestDriver@123' },
  { email: 'driver.slt109@bus.com', name: 'Drivers Team 109', phone: '+94701234576', password: 'TestDriver@123' },
  { email: 'driver.slt110@bus.com', name: 'Drivers Team 110', phone: '+94701234577', password: 'TestDriver@123' },
  { email: 'driver.slt111@bus.com', name: 'Drivers Team 111', phone: '+94701234578', password: 'TestDriver@123' },
  { email: 'driver.slt112@bus.com', name: 'Drivers Team 112', phone: '+94701234579', password: 'TestDriver@123' },
  { email: 'driver.slt113@bus.com', name: 'Drivers Team 113', phone: '+94701234580', password: 'TestDriver@123' },
  { email: 'driver.slt114@bus.com', name: 'Drivers Team 114', phone: '+94701234581', password: 'TestDriver@123' },
  { email: 'driver.slt115@bus.com', name: 'Drivers Team 115', phone: '+94701234582', password: 'TestDriver@123' }
];

async function seedBuses() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bus-tracking');

    console.log('✅ Connected to MongoDB');
    
    // Create or get test drivers
    console.log('📝 Setting up test drivers...');
    const bcrypt = require('bcryptjs');
    const drivers = [];
    
    for (const driverData of TEST_DRIVERS) {
      let driver = await Driver.findOne({ email: driverData.email });
      if (!driver) {
        const hashedPassword = await bcrypt.hash(driverData.password, 10);
        driver = await Driver.create({
          email: driverData.email,
          name: driverData.name,
          phoneNumber: driverData.phone,
          password: hashedPassword,
          isEmailVerified: true
        });
      }
      drivers.push(driver);
    }
    console.log(`✅ ${drivers.length} test drivers ready\n`);
    
    // Define buses with driver assignments
    const TEST_BUSES = [
      // Route 100: Colombo - Kandy Express
      { busId: 'SL100-A', busName: 'High Country Express A', registrationNumber: 'REG-SL-100-A-2024', numberPlate: 'SL-NO-1001', routeId: '100', driverId: drivers[0]._id, seatCapacity: 45, busType: 'AC', serviceType: 'PUBLIC', isActive: true },
      { busId: 'SL100-B', busName: 'High Country Express B', registrationNumber: 'REG-SL-100-B-2024', numberPlate: 'SL-NO-1002', routeId: '100', driverId: drivers[0]._id, seatCapacity: 45, busType: 'AC', serviceType: 'PUBLIC', isActive: true },
      { busId: 'SL100-C', busName: 'Hill Country Local', registrationNumber: 'REG-SL-100-C-2024', numberPlate: 'SL-NO-1003', routeId: '100', driverId: drivers[0]._id, seatCapacity: 52, busType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 101: Colombo - Galle Highway
      { busId: 'SL101-A', busName: 'South Coast Express', registrationNumber: 'REG-SL-101-A-2024', numberPlate: 'SL-NO-1004', routeId: '101', driverId: drivers[1]._id, seatCapacity: 45, busType: 'AC', serviceType: 'PUBLIC', isActive: true },
      { busId: 'SL101-B', busName: 'Galle Beach Shuttle', registrationNumber: 'REG-SL-101-B-2024', numberPlate: 'SL-NO-1005', routeId: '101', driverId: drivers[1]._id, seatCapacity: 52, busType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 102: Colombo - Negom Coastal
      { busId: 'SL102-A', busName: 'Negombo Express', registrationNumber: 'REG-SL-102-A-2024', numberPlate: 'SL-NO-1006', routeId: '102', driverId: drivers[2]._id, seatCapacity: 35, busType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      { busId: 'SL102-B', busName: 'Coastal Highway', registrationNumber: 'REG-SL-102-B-2024', numberPlate: 'SL-NO-1007', routeId: '102', driverId: drivers[2]._id, seatCapacity: 35, busType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 103: Colombo - Anuradhapura Heritage
      { busId: 'SL103-A', busName: 'Ancient City Express', registrationNumber: 'REG-SL-103-A-2024', numberPlate: 'SL-NO-1008', routeId: '103', driverId: drivers[3]._id, seatCapacity: 45, busType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 104: Kandy - Nuwara Eliya Hill Country
      { busId: 'SL104-A', busName: 'Tea Country Express', registrationNumber: 'REG-SL-104-A-2024', numberPlate: 'SL-NO-1009', routeId: '104', driverId: drivers[4]._id, seatCapacity: 40, busType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 105: Galle - Matara South Coast
      { busId: 'SL105-A', busName: 'Southern Gem', registrationNumber: 'REG-SL-105-A-2024', numberPlate: 'SL-NO-1010', routeId: '105', driverId: drivers[5]._id, seatCapacity: 35, busType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 106: Colombo - Jaffna Northern Main
      { busId: 'SL106-A', busName: 'Northern Explorer A', registrationNumber: 'REG-SL-106-A-2024', numberPlate: 'SL-NO-1011', routeId: '106', driverId: drivers[6]._id, seatCapacity: 50, busType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 107: Trincomalee - Batticaloa East Coast
      { busId: 'SL107-A', busName: 'East Coast Link', registrationNumber: 'REG-SL-107-A-2024', numberPlate: 'SL-NO-1012', routeId: '107', driverId: drivers[7]._id, seatCapacity: 40, busType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 108: Colombo - Negombo Private Shuttle (OFFICE)
      { busId: 'SL108-A', busName: 'Negombo Office Shuttle', registrationNumber: 'REG-SL-108-A-2024', numberPlate: 'SL-NO-1013', routeId: '108', driverId: drivers[8]._id, seatCapacity: 20, busType: 'DELUXE', serviceType: 'OFFICE', isActive: true },
      
      // Route 109: Colombo - Kandy University Shuttle (UNIVERSITY)
      { busId: 'SL109-A', busName: 'University Link 1', registrationNumber: 'REG-SL-109-A-2024', numberPlate: 'SL-NO-1014', routeId: '109', driverId: drivers[9]._id, seatCapacity: 50, busType: 'NON-AC', serviceType: 'UNIVERSITY', isActive: true },
      { busId: 'SL109-B', busName: 'University Link 2', registrationNumber: 'REG-SL-109-B-2024', numberPlate: 'SL-NO-1015', routeId: '109', driverId: drivers[9]._id, seatCapacity: 50, busType: 'NON-AC', serviceType: 'UNIVERSITY', isActive: true },
      
      // Route 110: Colombo - Bambalapitiya School Transport (SCHOOL)
      { busId: 'SL110-A', busName: 'School Bus A', registrationNumber: 'REG-SL-110-A-2024', numberPlate: 'SL-NO-1016', routeId: '110', driverId: drivers[10]._id, seatCapacity: 35, busType: 'NON-AC', serviceType: 'SCHOOL', isActive: true },
      { busId: 'SL110-B', busName: 'School Bus B', registrationNumber: 'REG-SL-110-B-2024', numberPlate: 'SL-NO-1017', routeId: '110', driverId: drivers[10]._id, seatCapacity: 35, busType: 'NON-AC', serviceType: 'SCHOOL', isActive: true },
      
      // Route 111: Kandy - Badulla Mountain Express
      { busId: 'SL111-A', busName: 'Mountain Express', registrationNumber: 'REG-SL-111-A-2024', numberPlate: 'SL-NO-1018', routeId: '111', driverId: drivers[11]._id, seatCapacity: 40, busType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 112: Colombo - Matara Southern Express
      { busId: 'SL112-A', busName: 'Matara Express', registrationNumber: 'REG-SL-112-A-2024', numberPlate: 'SL-NO-1019', routeId: '112', driverId: drivers[12]._id, seatCapacity: 45, busType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 113: Kurunegala - Puttalam West Route
      { busId: 'SL113-A', busName: 'West Route Link', registrationNumber: 'REG-SL-113-A-2024', numberPlate: 'SL-NO-1020', routeId: '113', driverId: drivers[13]._id, seatCapacity: 40, busType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 114: Galle - Hikkaduwa Beach Shuttle
      { busId: 'SL114-A', busName: 'Beach Shuttle', registrationNumber: 'REG-SL-114-A-2024', numberPlate: 'SL-NO-1021', routeId: '114', driverId: drivers[14]._id, seatCapacity: 32, busType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 115: Colombo - Ratnapura Gem Route
      { busId: 'SL115-A', busName: 'Gem City Express', registrationNumber: 'REG-SL-115-A-2024', numberPlate: 'SL-NO-1022', routeId: '115', driverId: drivers[15]._id, seatCapacity: 40, busType: 'AC', serviceType: 'PUBLIC', isActive: true }
    ];
    
    // Delete existing test buses to avoid duplicates
    const busIds = TEST_BUSES.map(b => b.busId);
    await Bus.deleteMany({ busId: { $in: busIds } });
    console.log('🗑️  Cleared existing test buses');
    
    const createdBuses = await Bus.insertMany(TEST_BUSES);
    console.log(`\n🎉 Successfully seeded ${createdBuses.length} test buses into the system\n`);

    // Group by route and display
    const busesByRoute = {};
    createdBuses.forEach((bus) => {
      if (!busesByRoute[bus.routeId]) {
        busesByRoute[bus.routeId] = [];
      }
      busesByRoute[bus.routeId].push(bus);
    });

    Object.keys(busesByRoute).sort().forEach((routeId) => {
      console.log(`   Route ${routeId}: ${busesByRoute[routeId].length} buses`);
      busesByRoute[routeId].forEach((bus) => {
        console.log(`      - ${bus.busId}: ${bus.busName} (${bus.seatCapacity} seats, ${bus.serviceType})`);
      });
    });

    console.log('\n✅ Database connection closed');
    await mongoose.connection.close();
  } catch (error) {
    console.error('❌ Error seeding buses:', error.message);
    process.exit(1);
  }
}

seedBuses();
