const mongoose = require('mongoose');
const request = require('supertest');
const { io: client } = require('socket.io-client');
const app = require('../../src/server');
const { createRider, createDriver, authHeader } = require('./factories');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const Rider = require('../../src/models/RiderProfile');
const Enrollment = require('../../src/models/DriverEnrollment');
const Notification = require('../../src/models/Notification');
const { Absence, Message, Conversation, Announcement, PushDelivery } = require('../../src/models/Communication');
const { dispatch, retireAbsences, startDispatcher } = require('../../src/services/communications');
const { today } = require('../../src/utils/communicationTemplates');

// How fast a message lands. In production every database round trip costs
// ~230 ms, and delivery used to wait for a 3 s poller and then make about 8
// sequential queries per rider, so a 20-rider broadcast reached its last rider
// about a minute late. These lock in the fix: a write is delivered the moment it
// happens, and a dispatcher pass costs the same whatever the number of riders.
let account, other, driver, secondDriver, amal;
const post = (path, body, actor) => request(app).post(`/api/${path}`).set(...authHeader(actor.token)).send(body);
const report = (riderId, driverId) => post('absences', { riderId: String(riderId), date: today(), requestId: `report-${riderId}-${driverId}`, drivers: [{ driverId: String(driverId), expectedRevision: 0 }] }, account);
beforeAll(async () => {
  await connectTestDb(); await clearTestDb();
  await Promise.all([Absence.init(), Message.init(), Conversation.init(), Announcement.init(), Notification.init(), PushDelivery.init()]);
});
beforeEach(async () => {
  await clearTestDb();
  account = await createRider(); other = await createRider();
  driver = await createDriver(); secondDriver = await createDriver();
  amal = await Rider.create({ accountId: account.id, fullName: 'Amal', riderCode: 'RDR-AMAL' });
  await Enrollment.create([
    { studentId: amal._id, driverId: driver.id, status: 'ACTIVE' },
    { studentId: amal._id, driverId: secondDriver.id, status: 'ACTIVE' },
  ]);
});
afterAll(closeTestDb);

// Database operations mongoose issues while `fn` runs.
async function countQueries(fn) {
  let count = 0;
  mongoose.set('debug', () => { count += 1; });
  try { await fn(); } finally { mongoose.set('debug', false); }
  return count;
}

// `size` riders enrolled with `owner`, split across both rider accounts so the
// grouped push covers more than one household.
async function rosterFor(owner, size) {
  const riders = await Rider.create(Array.from({ length: size }, (_, i) => ({ accountId: (i % 2 ? other : account).id, fullName: `Rider ${i}`, riderCode: `RDR-${owner.id}-${i}` })));
  await Enrollment.create(riders.map(r => ({ studentId: r._id, driverId: owner.id, status: 'ACTIVE' })));
  return riders;
}
const broadcast = (owner, riders) => post('driver/announcements', {
  requestId: `broadcast-${owner.id}`, templateId: 'on_my_way', audience: 'all', date: today(),
  recipientCount: riders.length, previewRiderIds: riders.map(r => String(r._id)),
}, owner).expect(200);

test('an absence reaches the driver socket as soon as it is reported, not on the next poll', async () => {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const socket = client(`http://127.0.0.1:${app.server.address().port}`, { auth: { token: driver.token }, transports: ['websocket'], forceNew: true });
  // An hour-long interval: only the kick from the write can deliver in time.
  const stop = startDispatcher(app.get('io'), { intervalMs: 3600000 });
  try {
    await new Promise((resolve, reject) => { socket.once('connection-success', resolve); socket.once('connect_error', reject); });
    // Well inside the old 3 s poll; locally the kick delivers in well under a second.
    const arrived = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no communication:event within 2 s')), 2000);
      socket.once('communication:event', event => { clearTimeout(timer); resolve(event); });
    });
    const stored = new Promise(resolve => socket.once('notification:new', resolve));
    await report(amal._id, driver.id).expect(200);
    const event = await arrived;
    expect(event).toMatchObject({ riderId: String(amal._id), absenceStatus: 'ABSENT', sender: 'system', text: `Amal will be absent on ${today()}.` });
    // The row the unread badge counts exists by the time it is announced.
    const announced = await stored;
    expect(await Notification.exists({ _id: announced.notificationId, recipientRole: 'driver' })).toBeTruthy();
  } finally {
    stop(); socket.disconnect();
    await new Promise(resolve => setTimeout(resolve, 300));
    await new Promise(resolve => app.server.close(resolve));
  }
});

test('a broadcast pass costs the same number of queries for 2 riders as for 8', async () => {
  const few = await rosterFor(driver, 2);
  const many = await rosterFor(secondDriver, 8);
  // Amal is enrolled with both drivers too.
  await broadcast(driver, [amal, ...few]);
  const small = await countQueries(() => dispatch(undefined, { retire: false }));
  await broadcast(secondDriver, [amal, ...many]);
  const large = await countQueries(() => dispatch(undefined, { retire: false }));
  expect(large).toBe(small);
  expect(small).toBeLessThanOrEqual(20);
  // A pass with nothing to do stays cheap.
  expect(await countQueries(() => dispatch(undefined, { retire: false }))).toBeLessThanOrEqual(3);

  // Same outcome per recipient as one-at-a-time delivery: a message, a stored
  // notification and a socket-ready thread each, one grouped push per account.
  const announcement = await Announcement.findOne({ driverId: secondDriver.id });
  expect(announcement.recipients.map(r => r.state)).toEqual(Array(9).fill('sent'));
  expect(announcement.pushQueued).toBe(true);
  expect(await Message.countDocuments({ announcementId: announcement._id, deliveryPending: false })).toBe(9);
  expect(await Notification.countDocuments({ type: 'COMMUNICATION', recipientRole: 'user', 'data.eventId': new RegExp(`^announcement:${announcement._id}:`) })).toBe(9);
  expect(await Conversation.countDocuments({ driverId: secondDriver.id })).toBe(9);
  const pushes = await PushDelivery.find({ eventId: new RegExp(`^announcement:${announcement._id}:account:`) }).lean();
  expect(pushes.map(p => String(p.recipientId)).sort()).toEqual([String(account.id), String(other.id)].sort());
  expect(pushes.find(p => String(p.recipientId) === String(account.id)).title).toBe('Driver update · 5 riders');

  // A repeated pass writes nothing new.
  await dispatch(undefined, { retire: false });
  expect(await Message.countDocuments({ announcementId: announcement._id })).toBe(9);
  expect(await PushDelivery.countDocuments({ eventId: /^announcement:/ })).toBe(4);
});

test('a broadcast skips a rider who left and fails all when the driver is unavailable', async () => {
  const riders = await rosterFor(driver, 2);
  const a = (await broadcast(driver, [amal, ...riders])).body.data;
  await Enrollment.deleteOne({ studentId: riders[0]._id, driverId: driver.id });
  await dispatch(undefined, { retire: false });
  const states = Object.fromEntries((await Announcement.findById(a._id)).recipients.map(r => [String(r.riderId), r.state]));
  expect(states).toEqual({ [String(amal._id)]: 'sent', [String(riders[0]._id)]: 'skipped', [String(riders[1]._id)]: 'sent' });

  const later = await rosterFor(secondDriver, 1);
  const b = (await broadcast(secondDriver, [amal, ...later])).body.data;
  await mongoose.model('Driver').updateOne({ _id: secondDriver.id }, { isActive: false });
  await dispatch(undefined, { retire: false });
  const failed = (await Announcement.findById(b._id)).recipients;
  expect(failed.map(r => r.state)).toEqual(['failed', 'failed']);
  expect(failed[0].error).toBe('Delivery failed. Retry this recipient.');
  expect(await Message.countDocuments({ announcementId: b._id })).toBe(0);
});

test('the retire sweep retires exactly the notices whose enrollment or rider ended', async () => {
  await report(amal._id, driver.id).expect(200);
  await report(amal._id, secondDriver.id).expect(200);
  await Enrollment.updateOne({ studentId: amal._id, driverId: secondDriver.id }, { status: 'REJECTED' });
  // Most dispatcher passes skip the sweep; it runs once a minute.
  await dispatch(undefined, { retire: false });
  expect(await Absence.countDocuments({ status: 'RETIRED' })).toBe(0);

  expect(await retireAbsences()).toBe(1);
  expect((await Absence.findOne({ driverId: secondDriver.id })).status).toBe('RETIRED');
  expect((await Absence.findOne({ driverId: driver.id })).status).toBe('ABSENT');
  await dispatch(undefined, { retire: false });
  expect(await Message.exists({ absenceStatus: 'RETIRED', text: `Absence notice for Amal on ${today()} retired because enrollment ended.` })).toBeTruthy();

  // A rider who is no longer active retires the rest.
  await Rider.updateOne({ _id: amal._id }, { isActive: false });
  expect(await retireAbsences()).toBe(1);
  expect(await Absence.countDocuments({ status: 'RETIRED' })).toBe(2);
});
