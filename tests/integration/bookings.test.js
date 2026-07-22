const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Driver = require('../../src/models/Driver');
const Route = require('../../src/models/Route');
const Bus = require('../../src/models/Bus');
const { connectTestDb, closeTestDb } = require('./db');

// Matches the real API: POST /api/bookings expects
// { busId, routeId, seatNumbers[], journeyDate, pricePerSeat, totalPrice, ... }
// and returns 201 { message: 'Booking created successfully', booking, ... }.

const JOURNEY_DATE = '2030-01-15T08:00:00.000Z';
const PASSENGER = { email: `booker-${Date.now()}@test.com`, password: 'P@ssw0rd!' };

let token;
let bus;
let route;

beforeAll(async () => {
  await connectTestDb();

  // Passenger + auth token
  await User.create({
    name: 'Booking Tester',
    email: PASSENGER.email,
    password: PASSENGER.password,
    role: 'user',
    isEmailVerified: true,
    isActive: true,
  });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: PASSENGER.email, password: PASSENGER.password });
  token = login.body.accessToken;

  // A driver is required to create a bus.
  const driver = await Driver.create({
    name: 'Booking Driver',
    email: `bdriver-${Date.now()}@test.com`,
    password: 'Driver@123',
    isEmailVerified: true,
    isActive: true,
  });

  route = await Route.create({
    routeId: `T-${Date.now()}`,
    routeName: 'Test Route',
    source: 'Origin',
    destination: 'Destination',
    distance: 10,
    fare: 50,
    serviceType: 'PUBLIC',
    stops: [
      { stopName: 'Origin', order: 1, lat: 6.9271, lng: 79.8612 },
      { stopName: 'Destination', order: 2, lat: 6.8472, lng: 79.9265 },
    ],
  });

  bus = await Bus.create({
    busId: `BT-${Date.now()}`,
    busName: 'Booking Test Bus',
    registrationNumber: `REG-${Date.now()}`,
    numberPlate: `NP-${Date.now()}`,
    routeId: route.routeId,
    driverId: driver._id,
    seatCapacity: 45,
    busType: 'NON-AC',
    serviceType: 'PUBLIC',
    bookingEnabled: true,
  });
});

afterAll(async () => {
  await closeTestDb();
});

function bookingPayload(seatNumbers) {
  return {
    busId: bus._id.toString(),
    routeId: route._id.toString(),
    seatNumbers,
    journeyDate: JOURNEY_DATE,
    pickupStopIndex: 0,
    dropoffStopIndex: 1,
    pricePerSeat: 50,
    totalPrice: 50 * seatNumbers.length,
  };
}

describe('Bookings Integration - POST /api/bookings', () => {
  test('creates a booking with valid data (201)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(bookingPayload([2]));

    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/booking created successfully/i);
    expect(res.body.booking).toHaveProperty('_id');
    expect(res.body.booking.seatNumbers).toContain(2);
  });

  test('rejects missing required fields with 400 validation errors', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ busId: bus._id.toString() }); // missing routeId, seatNumbers, etc.

    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('requires authentication (401 without token)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .send(bookingPayload([9]));

    expect(res.status).toBe(401);
  });

  test('returns 409 when a seat is already booked', async () => {
    const first = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(bookingPayload([3]));
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(bookingPayload([3]));

    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already booked/i);
    expect(second.body.conflictingSeats).toContain(3);
  });
});
