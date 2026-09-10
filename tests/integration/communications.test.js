const request = require('supertest');
const { io: client } = require('socket.io-client');
const app = require('../../src/server');
const { createRider, createDriver, authHeader } = require('./factories');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const Rider = require('../../src/models/RiderProfile');
const User = require('../../src/models/User');
const Enrollment = require('../../src/models/DriverEnrollment');
const Notification = require('../../src/models/Notification');
const { Absence, Message, Conversation, Announcement, PushDelivery } = require('../../src/models/Communication');
const { dispatch } = require('../../src/services/communications');
const { today, validateDate, canonical } = require('../../src/utils/communicationTemplates');
let account, outsider, driver, secondDriver, amal, sibling;
const post = (path, body, actor = account) => request(app).post(`/api/${path}`).set(...authHeader(actor.token)).send(body);
const get = (path, actor = account) => request(app).get(`/api/${path}`).set(...authHeader(actor.token));
const report = (requestId = 'report-0001', drivers = [{ driverId: String(driver.id), expectedRevision: 0 }]) => post('absences', { riderId: String(amal._id), date: today(), requestId, drivers });
beforeAll(async () => {
  await connectTestDb(); await clearTestDb();
  await Promise.all([Absence.init(), Message.init(), Conversation.init(), Announcement.init(), Notification.init(), PushDelivery.init()]);
});
beforeEach(async () => {
  await clearTestDb();
  account = await createRider(); outsider = await createRider();
  driver = await createDriver(); secondDriver = await createDriver();
  amal = await Rider.create({ accountId: account.id, fullName: 'Amal', riderCode: 'RDR-AMAL' });
  sibling = await Rider.create({ accountId: account.id, fullName: 'Sibling', riderCode: 'RDR-SIBLING' });
  await Enrollment.create([
    { studentId: amal._id, driverId: driver.id, status: 'ACTIVE' },
    { studentId: sibling._id, driverId: driver.id, status: 'ACTIVE' },
    { studentId: amal._id, driverId: secondDriver.id, status: 'ACTIVE' },
  ]);
});
afterAll(closeTestDb);
test('report → read → cancel → acknowledge is revisioned and sibling isolated', async () => {
  const response = await report(); expect(response.status).toBe(200);
  const a = response.body.data.results[0].absence;
  expect(a.status).toBe('ABSENT');
  await dispatch(); await dispatch();
  expect(await Message.countDocuments()).toBe(1);
  const message = await Message.findOne();
  await request(app).put(`/api/conversations/${a.conversationId}/read`).set(...authHeader(driver.token)).send({ throughMessageId: String(message._id) }).expect(200);
  expect((await Absence.findById(a._id)).acknowledgedRevision).toBe(0);
  const cancelled = await post(`absences/${a._id}/cancel`, { requestId: 'cancel-0001', expectedRevision: 1 });
  expect(cancelled.body.data.revision).toBe(2);
  let list = (await get(`driver/absences?date=${today()}`, driver)).body.data;
  expect(list.absentCount).toBe(0); expect(list.changes).toHaveLength(1);
  await post(`absences/${a._id}/acknowledge`, { requestId: 'ack-old-0001', expectedRevision: 1 }, driver).expect(409);
  await post(`absences/${a._id}/acknowledge`, { requestId: 'ack-new-0001', expectedRevision: 2 }, driver).expect(200);
  await dispatch();
  list = (await get('driver/absences', driver)).body.data;
  expect(list.changes).toHaveLength(0);
  expect(await Absence.countDocuments({ riderId: sibling._id })).toBe(0);
  expect(await Message.countDocuments()).toBe(3);
  expect((await Absence.findById(a._id)).history).toHaveLength(3);
});
test('concurrent requests and uncertain-response retries cannot duplicate a change', async () => {
  const results = await Promise.all([report(), report(), report()]);
  results.forEach(r => expect(r.body.data.results[0].success).toBe(true));
  expect(await Absence.countDocuments()).toBe(1);
  expect((await Absence.findOne()).history).toHaveLength(1);
  await dispatch(); expect(await Message.countDocuments()).toBe(1);
});
test('per-driver results and acknowledgment are independent; ownership is enforced', async () => {
  const response = await report('report-multi', [{ driverId: String(driver.id), expectedRevision: 0 }, { driverId: String(secondDriver.id), expectedRevision: 0 }]);
  expect(response.body.data.results.every(r => r.success)).toBe(true);
  const a = response.body.data.results[0].absence;
  await post(`absences/${a._id}/cancel`, { requestId: 'outside-0001', expectedRevision: 1 }, outsider).expect(404);
  await post(`absences/${a._id}/acknowledge`, { requestId: 'wrong-driver', expectedRevision: 1 }, secondDriver).expect(404);
  await get(`conversations/${a.conversationId}/messages`, outsider).expect(404);
  await post(`absences/${a._id}/acknowledge`, { requestId: 'correct-driver', expectedRevision: 1 }, driver).expect(200);
  const other = await Absence.findOne({ driverId: secondDriver.id }); expect(other.acknowledgedRevision).toBe(0);
});
test('plain text never changes absences; canonical templates and request reuse are validated', async () => {
  const c = (await post('conversations', { riderId: String(amal._id), driverId: String(driver.id) })).body.data;
  const body = { requestId: 'typed-00001', text: 'Absent today' };
  await post(`conversations/${c._id}/messages`, body).expect(200);
  await post(`conversations/${c._id}/messages`, body).expect(200);
  await post(`conversations/${c._id}/messages`, { ...body, text: 'Different' }).expect(409);
  await post(`conversations/${c._id}/messages`, { requestId: 'too-long-001', text: 'a'.repeat(1001) }).expect(400);
  expect(await Absence.countDocuments()).toBe(0); expect(await Message.countDocuments()).toBe(1);
});
test('the quick-action grid is exactly the two presets a driver can tap mid-route', async () => {
  const response = await get('conversations/presets', driver).expect(200);
  expect(response.body.data.presets.map(p => p.id)).toEqual(['on_my_way', 'delay_10']);
  // Delay wording names no cause: a driver seldom knows why they are behind.
  expect(response.body.data.presets.find(p => p.id === 'delay_10').text).not.toMatch(/traffic/i);
  // The open-ended delay behind More updates stays available and stays neutral.
  expect(canonical({ templateId: 'traffic', parameters: { minutes: 25 } }, 'driver', null, true))
    .toBe('I’m running about 25 minutes behind. Sorry for the inconvenience, I’ll update you if this changes.');
});
test('broadcasts include absent riders, remain private and group sibling pushes', async () => {
  await report();
  const body = { requestId: 'broadcast-001', templateId: 'delay_10', audience: 'all', date: today(), recipientCount: 2, previewRiderIds: [String(amal._id), String(sibling._id)] };
  const results = await Promise.all([post('driver/announcements', body, driver), post('driver/announcements', body, driver)]);
  results.forEach(r => expect(r.status).toBe(200));
  await dispatch(); await dispatch();
  expect(await Announcement.countDocuments()).toBe(1);
  expect(await Message.countDocuments({ announcementId: results[0].body.data._id })).toBe(2);
  expect(await PushDelivery.countDocuments({ eventId: /^announcement:/ })).toBe(1);
  expect((await Announcement.findOne()).recipients.every(r => r.state === 'sent')).toBe(true);
  await post('driver/announcements', { ...body, requestId: 'arrived-all', templateId: 'arrived' }, driver).expect(400);
  // A preset that was retired from the grid must stop being accepted, or a stale
  // client keeps sending wording nobody can see or edit any more.
  await post('driver/announcements', { ...body, requestId: 'retired-preset', templateId: 'traffic_5' }, driver).expect(400);
  await post('driver/announcements', { ...body, requestId: 'wrong-count', recipientCount: 3 }, driver).expect(409);
  await get(`driver/announcements/${results[0].body.data._id}`, secondDriver).expect(404);
});
test('enrollment removal retires notices; re-enrollment cannot resurrect them', async () => {
  const a = (await report()).body.data.results[0].absence;
  const enrollment = await Enrollment.findOne({ studentId: amal._id, driverId: driver.id });
  await request(app).delete(`/api/enrollments/${enrollment._id}`).set(...authHeader(account.token)).expect(200);
  expect((await Absence.findById(a._id)).status).toBe('RETIRED');
  await get(`conversations/${a.conversationId}/messages`).expect(200);
  await post(`conversations/${a.conversationId}/messages`, { requestId: 'former-0001', text: 'Hello' }).expect(403);
  await Enrollment.create({ studentId: amal._id, driverId: driver.id, status: 'ACTIVE' });
  await dispatch(); expect((await Absence.findById(a._id)).status).toBe('RETIRED');
});
test('recipient authorization is rechecked before delivery and retries touch only failed recipients', async () => {
  const body = { requestId: 'broadcast-skip', templateId: 'on_my_way', audience: 'all', date: today(), recipientCount: 2, previewRiderIds: [String(amal._id), String(sibling._id)] };
  const a = (await post('driver/announcements', body, driver)).body.data;
  await Enrollment.deleteOne({ studentId: sibling._id, driverId: driver.id });
  await dispatch(); await post(`driver/announcements/${a._id}/retry`, {}, driver); await dispatch();
  expect(await Message.countDocuments()).toBe(1);
  expect((await Announcement.findById(a._id)).recipients.map(r => r.state).sort()).toEqual(['sent', 'skipped']);
});
test('date boundaries use Colombo and reject impossible, past, and distant dates', () => {
  expect(today(new Date('2026-09-08T18:30:00Z'))).toBe('2026-09-09');
  expect(() => validateDate('2026-02-30')).toThrow();
  expect(() => validateDate('2000-01-01')).toThrow();
  expect(() => validateDate('2099-01-01')).toThrow();
  expect(() => canonical({ templateId: 'running_late', parameters: { minutes: -1 } }, 'user', 'Amal')).toThrow();
});
test('authenticated socket receives stable private events, unrelated driver receives none', async () => {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const sockets = [driver, secondDriver].map(actor => client(url, { auth: { token: actor.token }, transports: ['websocket'], forceNew: true }));
  try {
    await Promise.all(sockets.map(socket => new Promise((resolve, reject) => { socket.once('connection-success', resolve); socket.once('connect_error', reject); })));
    const received = []; const foreign = [];
    sockets[0].on('communication:event', e => received.push(e)); sockets[1].on('communication:event', e => foreign.push(e));
    await report(); await dispatch(app.get('io'));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(received).toHaveLength(1); expect(received[0].riderId).toBe(String(amal._id)); expect(foreign).toHaveLength(0);
  } finally { sockets.forEach(socket => socket.disconnect()); await new Promise(resolve => app.server.close(resolve)); }
});

// The driver-facing rider directory. A driver sees only riders currently enrolled
// with them, the roster stays cheap enough to poll, and the contact number is
// behind a second request rather than riding the list.
describe('driver rider directory', () => {
  const row = (body, riderId) => body.data.find(r => String(r.riderId) === String(riderId));

  test('the roster carries what a row renders, and nothing sensitive', async () => {
    await Rider.updateOne({ _id: amal._id }, { category: 'SCHOOL', details: { grade: '7', admissionNumber: 'ADM-9' }, avatarUrl: 'data:image/png;base64,AAAA', avatarVersion: 3 });
    await Rider.updateOne({ _id: sibling._id }, { category: 'UNIVERSITY', details: { grade: '11', studentNumber: 'U-42' } });
    await User.updateOne({ _id: account.id }, { phoneNumber: '0779999999' });

    const body = (await get('driver/riders', driver)).body;
    const amalRow = row(body, amal._id);
    expect(amalRow).toMatchObject({ riderName: 'Amal', category: 'SCHOOL', grade: '7', hasAvatar: true, avatarVersion: 3 });
    // The picture and the phone number are separate requests, by design.
    expect(amalRow.avatarUrl).toBeUndefined();
    expect(amalRow.contactNumber).toBeUndefined();
    expect(JSON.stringify(body.data)).not.toContain('0779999999');
    // `details` also holds the organization's enrolment answers, which are not
    // the driver's business — only what signup asks for the category comes back.
    expect(JSON.stringify(body.data)).not.toContain('ADM-9');
    expect(JSON.stringify(body.data)).not.toContain('U-42');

    // A university rider is never asked for a grade, so one stored against that
    // category is not shown.
    expect(row(body, sibling._id)).toMatchObject({ grade: '', hasAvatar: false });
  });

  test('a rider detail answers name, grade and one contact number', async () => {
    await Rider.updateOne({ _id: amal._id }, { category: 'SCHOOL', details: { grade: '7' }, guardianPhoneOverride: '0770000001' });
    const data = (await get(`driver/riders/${amal._id}`, driver)).body.data;
    expect(data).toMatchObject({ riderName: 'Amal', riderCode: 'RDR-AMAL', category: 'SCHOOL', grade: '7', contactNumber: '0770000001' });
    // The home address stays with the household; a driver sees the pickup label only.
    expect(data.address).toBeUndefined();
    expect(data.pickup).toBeUndefined();
  });

  test('the contact number is the rider override, else the account holder, else empty', async () => {
    await User.updateOne({ _id: account.id }, { phoneNumber: '0779999999' });
    expect((await get(`driver/riders/${amal._id}`, driver)).body.data.contactNumber).toBe('0779999999');

    await Rider.updateOne({ _id: amal._id }, { guardianPhoneOverride: '0770000001' });
    expect((await get(`driver/riders/${amal._id}`, driver)).body.data.contactNumber).toBe('0770000001');

    await User.updateOne({ _id: account.id }, { phoneNumber: '' });
    await Rider.updateOne({ _id: amal._id }, { guardianPhoneOverride: '' });
    expect((await get(`driver/riders/${amal._id}`, driver)).body.data.contactNumber).toBe('');
  });

  test('the picture is its own request, and no picture reads as empty', async () => {
    await Rider.updateOne({ _id: amal._id }, { avatarUrl: 'data:image/png;base64,AAAA', avatarVersion: 4 });
    expect((await get(`driver/riders/${amal._id}/avatar`, driver)).body.data).toEqual({ avatarUrl: 'data:image/png;base64,AAAA', avatarVersion: 4 });
    expect((await get(`driver/riders/${sibling._id}/avatar`, driver)).body.data.avatarUrl).toBe('');
  });

  // A rider the caller does not carry reads as missing rather than forbidden: a
  // 403 on a real id would tell a driver which rider ids exist.
  test('a rider a driver does not carry is missing, not forbidden', async () => {
    await get(`driver/riders/${sibling._id}`, secondDriver).expect(404);
    await get(`driver/riders/${sibling._id}/avatar`, secondDriver).expect(404);
    expect(row((await get('driver/riders', secondDriver)).body, sibling._id)).toBeUndefined();

    await Enrollment.updateMany({ studentId: amal._id, driverId: secondDriver.id }, { status: 'REJECTED' });
    await get(`driver/riders/${amal._id}`, secondDriver).expect(404);
    await get(`driver/riders/${amal._id}/avatar`, secondDriver).expect(404);
  });

  test('the directory is driver-only, authenticated, and rejects a malformed id', async () => {
    await get(`driver/riders/${amal._id}`, account).expect(403);
    await get(`driver/riders/${amal._id}/avatar`, account).expect(403);
    await request(app).get(`/api/driver/riders/${amal._id}`).expect(401);
    await get('driver/riders/not-an-id', driver).expect(400);
  });
});
