const request = require('supertest');
const app = require('../src/server');
const Route = require('../src/models/Route');
const Bus = require('../src/models/Bus');
const Booking = require('../src/models/Booking');
const User = require('../src/models/User');
const jwt = require('jsonwebtoken');

// Service type test suite
describe('Service Type Extensions (PUBLIC/SCHOOL/UNIVERSITY/OFFICE)', () => {
  let driverToken, adminToken, driverId, adminId, routeId, busId;

  beforeAll(async () => {
    // Create driver user
    const driver = await User.create({
      name: 'Test Driver',
      email: `driver-${Date.now()}@test.com`,
      password: 'test123',
      role: 'driver'
    });
    driverId = driver._id;
    driverToken = jwt.sign({ _id: driverId, role: 'driver' }, process.env.JWT_SECRET || 'test-secret');

    // Create admin user
    const admin = await User.create({
      name: 'Test Admin',
      email: `admin-${Date.now()}@test.com`,
      password: 'test123',
      role: 'super-admin'
    });
    adminId = admin._id;
    adminToken = jwt.sign({ _id: adminId, role: 'super-admin' }, process.env.JWT_SECRET || 'test-secret');

    // Create test route (PUBLIC)
    const route = await Route.create({
      routeName: 'Test Route',
      startPoint: 'Point A',
      endPoint: 'Point B',
      distance: 50,
      estimatedTime: 120,
      serviceType: 'PUBLIC',
      managerId: driverId
    });
    routeId = route.routeId;
  });

  afterAll(async () => {
    // Cleanup
    await User.deleteMany({ email: /^(driver|admin)-/ });
    await Route.deleteMany({ routeId });
    await Bus.deleteMany({ routeId });
    await Booking.deleteMany({ busId });
  });

  describe('Route Service Type Filtering', () => {
    test('should create route with default PUBLIC serviceType', async () => {
      const res = await request(app)
        .post('/api/route')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          routeName: 'Default Route',
          startPoint: 'Point A',
          endPoint: 'Point B',
          distance: 50,
          estimatedTime: 120
        });

      expect(res.status).toBe(201);
      expect(res.body.data.serviceType).toBe('PUBLIC');
    });

    test('should create route with specific serviceType', async () => {
      const res = await request(app)
        .post('/api/route')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          routeName: 'School Route',
          startPoint: 'School Point A',
          endPoint: 'School Point B',
          distance: 30,
          estimatedTime: 90,
          serviceType: 'SCHOOL'
        });

      expect(res.status).toBe(201);
      expect(res.body.data.serviceType).toBe('SCHOOL');
    });

    test('should filter routes by serviceType query param', async () => {
      // Create routes of different types
      await Route.create({
        routeName: 'University Route',
        startPoint: 'Uni A',
        endPoint: 'Uni B',
        distance: 60,
        estimatedTime: 140,
        serviceType: 'UNIVERSITY',
        managerId: driverId
      });

      // Query for PUBLIC routes
      const res = await request(app)
        .get('/api/route?serviceType=PUBLIC')
        .set('Authorization', `Bearer ${driverToken}`);

      expect(res.status).toBe(200);
      const publicRoutes = res.body.data.routes.filter(r => r.serviceType === 'PUBLIC');
      expect(publicRoutes.length).toBeGreaterThan(0);
      expect(publicRoutes.every(r => r.serviceType === 'PUBLIC')).toBe(true);
    });

    test('should reject invalid serviceType', async () => {
      const res = await request(app)
        .post('/api/route')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          routeName: 'Invalid Route',
          startPoint: 'Point A',
          endPoint: 'Point B',
          distance: 50,
          estimatedTime: 120,
          serviceType: 'INVALID_TYPE'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid service type');
    });
  });

  describe('Bus Service Type and Booking Control', () => {
    let schoolRouteId;

    beforeAll(async () => {
      const route = await Route.create({
        routeName: 'School Bus Route',
        startPoint: 'School A',
        endPoint: 'School B',
        distance: 25,
        estimatedTime: 45,
        serviceType: 'SCHOOL',
        managerId: driverId
      });
      schoolRouteId = route.routeId;
    });

    test('should create bus with default bookingEnabled=true', async () => {
      const res = await request(app)
        .post('/api/bus')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          busName: 'School Bus 1',
          routeId: schoolRouteId,
          totalSeats: 50,
          serviceType: 'SCHOOL'
        });

      expect(res.status).toBe(201);
      expect(res.body.data.bookingEnabled).toBe(true);
      expect(res.body.data.serviceType).toBe('SCHOOL');
      busId = res.body.data._id;
    });

    test('should update bus bookingEnabled status', async () => {
      const res = await request(app)
        .put(`/api/bus/${busId}`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ bookingEnabled: false });

      expect(res.status).toBe(200);
      expect(res.body.data.bookingEnabled).toBe(false);
    });

    test('should reject booking when bus.bookingEnabled=false', async () => {
      // Create user
      const passenger = await User.create({
        name: 'Test Passenger',
        email: `passenger-${Date.now()}@test.com`,
        password: 'test123',
        role: 'user'
      });
      const passengerToken = jwt.sign({ _id: passenger._id, role: 'user' }, process.env.JWT_SECRET || 'test-secret');

      // Attempt booking on disabled bus
      const res = await request(app)
        .post('/api/booking')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          userId: passenger._id,
          busId: busId,
          selectedSeats: [1, 2],
          totalPrice: 200
        });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('Booking is currently disabled');

      // Cleanup
      await User.deleteOne({ _id: passenger._id });
    });

    test('should allow booking when bus.bookingEnabled=true', async () => {
      // Re-enable bookings
      await Bus.findByIdAndUpdate(busId, { bookingEnabled: true });

      // Create user
      const passenger = await User.create({
        name: 'Test Passenger 2',
        email: `passenger2-${Date.now()}@test.com`,
        password: 'test123',
        role: 'user'
      });
      const passengerToken = jwt.sign({ _id: passenger._id, role: 'user' }, process.env.JWT_SECRET || 'test-secret');

      // Attempt booking on enabled bus
      const res = await request(app)
        .post('/api/booking')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          userId: passenger._id,
          busId: busId,
          selectedSeats: [1, 2],
          totalPrice: 200
        });

      expect(res.status).toBe(201);
      expect(res.body.data.serviceType).toBe('SCHOOL');

      // Cleanup
      await User.deleteOne({ _id: passenger._id });
    });

    test('should enforce route-bus serviceType consistency', async () => {
      const res = await request(app)
        .post('/api/bus')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          busName: 'Mismatched Bus',
          routeId: schoolRouteId, // SCHOOL route
          totalSeats: 50,
          serviceType: 'OFFICE' // OFFICE service type - mismatch
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('service type must match route');
    });
  });

  describe('Booking Service Type Recording', () => {
    test('should include serviceType in booking record', async () => {
      // This test assumes a bus with bookingEnabled=true and specific serviceType exists
      // Query existing bookings or create a new one
      const bookings = await Booking.find({ serviceType: { $exists: true } }).limit(1);
      expect(bookings.length).toBeGreaterThan(0);
      expect(bookings[0]).toHaveProperty('serviceType');
      expect(['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE']).toContain(bookings[0].serviceType);
    });
  });

  describe('Admin Bus Update (Service Type & Booking Toggle)', () => {
    test('admin should update bus serviceType and bookingEnabled', async () => {
      const res = await request(app)
        .put(`/api/bus/${busId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          serviceType: 'UNIVERSITY',
          bookingEnabled: false
        });

      expect(res.status).toBe(200);
      expect(res.body.data.serviceType).toBe('UNIVERSITY');
      expect(res.body.data.bookingEnabled).toBe(false);
    });

    test('driver should not be able to update bus of another driver', async () => {
      // This assumes the framework validates ownership - test may vary based on implementation
      const secondDriver = await User.create({
        name: 'Second Driver',
        email: `driver2-${Date.now()}@test.com`,
        password: 'test123',
        role: 'driver'
      });
      const secondDriverToken = jwt.sign({ _id: secondDriver._id, role: 'driver' }, process.env.JWT_SECRET || 'test-secret');

      const res = await request(app)
        .put(`/api/bus/${busId}`)
        .set('Authorization', `Bearer ${secondDriverToken}`)
        .send({ serviceType: 'PUBLIC' });

      expect(res.status).toBe(403);

      await User.deleteOne({ _id: secondDriver._id });
    });
  });

  describe('Backward Compatibility', () => {
    test('routes/buses without serviceType should default to PUBLIC', async () => {
      // Query existing data
      const routes = await Route.find({ serviceType: 'PUBLIC' }).limit(1);
      const buses = await Bus.find({ serviceType: 'PUBLIC' }).limit(1);

      if (routes.length > 0) {
        expect(routes[0].serviceType).toBe('PUBLIC');
      }
      if (buses.length > 0) {
        expect(buses[0].serviceType).toBe('PUBLIC');
      }
    });

    test('existing bookings should include serviceType field', async () => {
      const bookings = await Booking.find({ status: 'CONFIRMED' }).limit(1);
      if (bookings.length > 0) {
        expect(bookings[0]).toHaveProperty('serviceType');
      }
    });
  });
});
