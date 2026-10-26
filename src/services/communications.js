const crypto = require('crypto');
const mongoose = require('mongoose');
const { Conversation, Message, Absence, Announcement, PushDelivery } = require('../models/Communication');
const Rider = require('../models/RiderProfile');
const Enrollment = require('../models/DriverEnrollment');
const Driver = require('../models/Driver');
const Notification = require('../models/Notification');
const { ApiError } = require('../middleware/errorHandler');
const { today, validateDate, canonical } = require('../utils/communicationTemplates');
const { notificationCreated } = require('../utils/notificationEvents');
const { SIGNUP_FIELDS } = require('../utils/enrollmentSchema');
const { effectiveContactPhone, mapValuesToObject } = require('../utils/riders');
const id = value => String(value?._id || value);
function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new ApiError(400, 'Invalid resource ID');
  return value;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[\w-]{8,100}$/.test(value)) throw new ApiError(400, 'A stable requestId (8–100 characters) is required');
  return value;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sameRequest(existing, fingerprint) {
  if (existing.requestHash !== fingerprint) throw new ApiError(409, 'This requestId was used for a different operation');
}
async function upsert(Model, filter, fields) {
  try { return await Model.findOneAndUpdate(filter, { $setOnInsert: fields }, { new: true, upsert: true, runValidators: true }); }
  catch (error) { if (error.code !== 11000) throw error; return Model.findOne(filter); }
}
async function ownedRider(user, riderId, active = true) {
  const rider = await Rider.findOne({ _id: objectId(riderId), accountId: user._id, ...(active ? { isActive: true } : {}) });
  if (user.role !== 'user' || !rider) throw new ApiError(404, 'Rider not found');
  return rider;
}
async function activeEnrollment(riderId, driverId, enrollmentId) {
  return Enrollment.findOne({ studentId: riderId, driverId, status: 'ACTIVE', ...(enrollmentId ? { _id: enrollmentId } : {}) });
}
async function thread(user, riderId, driverId) {
  objectId(riderId); objectId(driverId);
  const rider = user.role === 'user' ? await ownedRider(user, riderId) : await Rider.findOne({ _id: riderId, isActive: true });
  if (!rider || (user.role === 'driver' && id(user) !== driverId)) throw new ApiError(404, 'Conversation not found');
  if (!await activeEnrollment(riderId, driverId)) throw new ApiError(403, 'Active enrollment is required');
  const driver = await Driver.findOne({ _id: driverId, isActive: { $ne: false } }).select('name');
  if (!driver) throw new ApiError(403, 'Driver unavailable');
  return upsert(Conversation, { riderId, driverId }, { riderId, driverId, accountId: rider.accountId, riderName: rider.fullName, driverName: driver.name });
}
async function assertWritable(conversation) {
  const [enrollment, rider] = await Promise.all([activeEnrollment(conversation.riderId, conversation.driverId), Rider.exists({ _id: conversation.riderId, isActive: true })]);
  if (!enrollment || !rider) throw new ApiError(403, 'Enrollment ended. History is read-only.');
}
async function accessibleThread(user, conversationId, writable = false) {
  const conversation = await Conversation.findOne({ _id: objectId(conversationId), [user.role === 'driver' ? 'driverId' : 'accountId']: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (writable) await assertWritable(conversation);
  return conversation;
}
async function createMessage(fields) {
  const message = await upsert(Message, { eventId: fields.eventId }, fields);
  if (fields.requestHash) sameRequest(message, fields.requestHash);
  return message;
}
async function send(user, conversationId, body) {
  const c = await accessibleThread(user, conversationId);
  const eventId = `text:${id(c)}:${user.role}:${requestId(body.requestId)}`;
  const text = canonical(body, user.role, c.riderName);
  const requestHash = hash([text, body.templateId || 'custom']);
  const existing = await Message.findOne({ eventId });
  if (existing) { sameRequest(existing, requestHash); return existing; }
  await assertWritable(c);
  const message = await createMessage({ conversationId, eventId, requestHash, text, templateId: body.templateId || 'custom', sender: user.role });
  kickDispatcher();
  return message;
}
// `status` is what the absence said when the driver acknowledged it, so the
// rider's notice repeats the thing that was seen rather than a generic "change".
function transitionText(name, date, action, status) {
  return action === 'ABSENT' ? `${name} will be absent on ${date}.`
    : action === 'CANCELLED' ? `${name} is coming on ${date}—absence cancelled.`
      : action === 'ACKNOWLEDGED' ? (
        status === 'ABSENT' ? `Driver acknowledged that ${name} will be absent on ${date}.`
          : status === 'CANCELLED' ? `Driver acknowledged that ${name} is coming on ${date}.`
            : `Driver acknowledged the absence change for ${name} on ${date}.`)
        : `Absence notice for ${name} on ${date} retired because enrollment ended.`;
}
async function transition(user, body, action, absenceId) {
  requestId(body.requestId);
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) throw new ApiError(400, 'expectedRevision is required');
  let existing = absenceId ? await Absence.findById(objectId(absenceId)) : null;
  if (absenceId && !existing) throw new ApiError(404, 'Absence not found');
  const riderId = existing ? id(existing.riderId) : objectId(body.riderId);
  const driverId = existing ? id(existing.driverId) : objectId(body.driverId);
  const date = existing?.date || body.date;
  if (action === 'ACKNOWLEDGED' && (user.role !== 'driver' || driverId !== id(user))) throw new ApiError(404, 'Absence not found');
  // The rider is read once and reused for ownership, the active check and the
  // thread below (it used to be three lookups), and independent reads go out
  // together: each one is a round trip to the database.
  const [rider, found] = await Promise.all([
    Rider.findOne({ _id: riderId, ...(action === 'ACKNOWLEDGED' ? {} : { accountId: user._id }) }).select('fullName accountId isActive'),
    existing || Absence.findOne({ riderId, driverId, date }),
  ]);
  if (action !== 'ACKNOWLEDGED' && (user.role !== 'user' || !rider)) throw new ApiError(404, 'Rider not found');
  existing = found;
  const requestHash = hash([riderId, driverId, date, action, body.expectedRevision]);
  const replay = existing?.history.find(h => h.requestId === body.requestId);
  if (replay) { sameRequest(replay, requestHash); return existing; }
  validateDate(date);
  const [enrollment, driver] = await Promise.all([
    activeEnrollment(riderId, driverId),
    Driver.findOne({ _id: driverId, isActive: { $ne: false } }).select('name'),
  ]);
  if (!enrollment || rider?.isActive !== true) throw new ApiError(403, 'Active enrollment is required');
  if ((existing?.revision || 0) !== body.expectedRevision) throw new ApiError(409, 'Absence changed. Refresh and review the latest revision.');
  if (action === 'ACKNOWLEDGED' && (existing?.status === 'RETIRED' || id(existing.enrollmentId) !== id(enrollment))) throw new ApiError(409, 'This notice is retired');
  if (action === 'CANCELLED' && existing?.status !== 'ABSENT') throw new ApiError(409, 'Only a current absence can be cancelled');
  if (action === 'ABSENT' && existing?.status === 'ABSENT' && id(existing.enrollmentId) === id(enrollment)) throw new ApiError(409, 'Rider is already absent on this date');
  if (!driver) throw new ApiError(403, 'Driver unavailable');
  const c = await upsert(Conversation, { riderId, driverId }, { riderId, driverId, accountId: rider.accountId, riderName: rider.fullName, driverName: driver.name });
  const revision = action === 'ACKNOWLEDGED' ? existing.revision : (existing?.revision || 0) + 1;
  const eventId = `absence:${id(c)}:${date}:${revision}:${action}`;
  const event = { eventId, requestId: body.requestId, requestHash, revision, action, text: transitionText(c.riderName, date, action, existing?.status), at: new Date(), pending: true };
  if (action === 'ACKNOWLEDGED' && existing.acknowledgedRevision === revision) return existing;
  const fields = action === 'ACKNOWLEDGED' ? { acknowledgedRevision: revision } : { status: action, revision, enrollmentId: enrollment._id };
  if (!existing) {
    try { const created = await Absence.create({ riderId, driverId, accountId: c.accountId, conversationId: c._id, date, ...fields, history: [event] }); kickDispatcher(); return created; }
    catch (error) { if (error.code !== 11000) throw error; }
  } else {
    const result = await Absence.findOneAndUpdate({ _id: existing._id, revision: body.expectedRevision, ...(action === 'ACKNOWLEDGED' ? { acknowledgedRevision: { $lt: revision } } : {}) }, { $set: fields, $push: { history: event } }, { new: true });
    if (result) { kickDispatcher(); return result; }
  }
  const latest = await Absence.findOne({ riderId, driverId, date });
  const repeated = latest?.history.find(h => h.requestId === body.requestId);
  if (repeated) { sameRequest(repeated, requestHash); return latest; }
  throw new ApiError(409, 'Absence changed. Refresh and review the latest revision.');
}
// Every query here costs a round trip to the database (~230 ms in production),
// and this used to make two per upcoming absence on every dispatcher pass. The
// checks are batched: one enrollment and one rider query for all of them.
async function retireAbsences(filter = {}) {
  const notices = await Absence.find({ ...filter, date: { $gte: today() }, status: { $ne: 'RETIRED' } }).lean();
  if (!notices.length) return 0;
  const riderIds = [...new Set(notices.map(a => id(a.riderId)))];
  const [enrollments, riders] = await Promise.all([
    Enrollment.find({ status: 'ACTIVE', studentId: { $in: riderIds }, driverId: { $in: [...new Set(notices.map(a => id(a.driverId)))] } }).select('_id studentId driverId').lean(),
    Rider.find({ _id: { $in: riderIds }, isActive: true }).select('_id').lean(),
  ]);
  const active = new Set(riders.map(r => id(r)));
  const live = a => enrollments.some(e => id(e.studentId) === id(a.riderId) && id(e.driverId) === id(a.driverId) && (!a.enrollmentId || id(e) === id(a.enrollmentId)));
  const ended = notices.filter(a => !live(a) || !active.has(id(a.riderId)));
  if (!ended.length) return 0;
  const conversations = await Conversation.find({ _id: { $in: ended.map(a => a.conversationId) } }).select('riderName').lean();
  const names = new Map(conversations.map(c => [id(c), c.riderName]));
  await Absence.bulkWrite(ended.map(a => {
    const revision = a.revision + 1;
    return { updateOne: { filter: { _id: a._id, revision: a.revision }, update: { $set: { status: 'RETIRED', revision }, $push: { history: {
      eventId: `absence:${id(a)}:${revision}:RETIRED`, revision, action: 'RETIRED', at: new Date(), pending: true, text: transitionText(names.get(id(a.conversationId)) || 'Rider', a.date, 'RETIRED'),
    } } } } };
  }), { ordered: false });
  kickDispatcher();
  return ended.length;
}
// Only what account creation asks for this category is safe to hand a driver.
// `details` also carries the organization's own enrolment answers — admission and
// employee numbers — which are not the driver's business.
function signupDetail(rider, key) {
  const allowed = SIGNUP_FIELDS[String(rider?.category || '').toUpperCase()] || [];
  if (!allowed.includes(key)) return '';
  return String(mapValuesToObject(rider.details)[key] || '').trim();
}

// `avatarUrl` holds the picture inline as a base64 data URL — up to the 2 MB
// account cap for riders migrated by ensureLegacyRider — so selecting it merely
// to test emptiness would pull a driver's whole roster of images into memory.
// This route is polled every 30 s by every focused driver, so that cost recurs
// twice a minute per driver to produce booleans that are then discarded.
// Deriving the flag in MongoDB keeps the blobs in the database; the $project is
// an allowlist and never emits avatarUrl itself.
//
// profileController.js keeps images off list responses for the same reason, but
// selects the field because it reasons about ~6 household members. A roster is
// 20-60, hence the divergence.
async function avatarFlags(riderIds) {
  if (!riderIds.length) return new Map();
  const rows = await Rider.aggregate([
    { $match: { _id: { $in: riderIds } } },
    { $project: { hasAvatar: { $gt: [{ $ifNull: ['$avatarUrl', ''] }, ''] } } }
  ]);
  return new Map(rows.map(row => [String(row._id), Boolean(row.hasAvatar)]));
}

async function audience(user, riderId) {
  const filter = { status: 'ACTIVE' };
  if (user.role === 'driver') filter.driverId = user._id;
  else { await ownedRider(user, objectId(riderId)); filter.studentId = riderId; }
  const rows = await Enrollment.find(filter).populate('studentId', 'fullName riderCode accountId avatarVersion isActive category details')
    .populate({ path: 'driverId', select: 'name organization isActive', populate: { path: 'organization', select: 'name' } })
    // Label only. The roster draws "Home gate", never the street, and sending an
    // address nothing renders would put every rider's home on the wire twice a
    // minute for no one to read.
    .populate('pickupPlaceId', 'label').lean();
  const active = rows.filter(row => row.studentId?.isActive && row.driverId?.isActive !== false);
  const flags = await avatarFlags(active.map(row => row.studentId._id));
  return active.map(row => ({
    enrollmentId: row._id, riderId: row.studentId._id, riderName: row.studentId.fullName,
    riderCode: row.studentId.riderCode, avatarVersion: row.studentId.avatarVersion,
    hasAvatar: flags.get(String(row.studentId._id)) || false,
    category: row.studentId.category || null, grade: signupDetail(row.studentId, 'grade'),
    driverId: row.driverId._id, driverName: row.driverId.name, organization: row.driverId.organization?.name || '', pickup: row.pickupPlaceId || null,
  }));
}

// One rider a driver is currently carrying. The contact number lives here rather
// than on the roster above because that list is polled every 30 s and this is
// looked at once — a deliberate tap, not a background refresh.
//
// A rider the caller has no active enrollment with is reported as missing, not
// forbidden: 403 on a real id would let a driver probe for rider ids.
async function riderDetail(user, riderId) {
  objectId(riderId);
  if (!await activeEnrollment(riderId, user._id)) throw new ApiError(404, 'Rider not found');
  const rider = await Rider.findOne({ _id: riderId, isActive: true })
    .select('fullName riderCode avatarVersion category details guardianPhoneOverride accountId')
    .populate('accountId', 'phoneNumber').lean();
  if (!rider) throw new ApiError(404, 'Rider not found');
  const flags = await avatarFlags([rider._id]);
  return {
    riderId: rider._id, riderName: rider.fullName, riderCode: rider.riderCode,
    avatarVersion: rider.avatarVersion || 0, hasAvatar: flags.get(String(rider._id)) || false,
    category: rider.category || null, grade: signupDetail(rider, 'grade'),
    contactNumber: effectiveContactPhone(rider, rider.accountId || {}),
  };
}

// Deliberately its own request, and never a field on riderDetail: the picture is
// a base64 data URL, and the client caches it against `avatarVersion` so a second
// look at the same rider costs nothing.
async function riderAvatar(user, riderId) {
  objectId(riderId);
  if (!await activeEnrollment(riderId, user._id)) throw new ApiError(404, 'Rider not found');
  const rider = await Rider.findOne({ _id: riderId, isActive: true }).select('+avatarUrl avatarVersion').lean();
  if (!rider) throw new ApiError(404, 'Rider not found');
  return { avatarUrl: rider.avatarUrl || '', avatarVersion: rider.avatarVersion || 0 };
}
async function announce(user, body) {
  requestId(body.requestId);
  if (!['all', 'selected'].includes(body.audience)) throw new ApiError(400, 'Select all or specific riders');
  const text = canonical(body, 'driver', null, true);
  const date = validateDate(body.date);
  if (body.templateId !== 'unavailable' && date !== today()) throw new ApiError(400, 'Broadcast date must be today');
  if (body.templateId === 'unavailable' && body.parameters?.date !== date) throw new ApiError(400, 'Notice date must match the preview');
  const selected = body.audience === 'selected' ? [...new Set((Array.isArray(body.riderIds) ? body.riderIds : []).map(objectId))].sort() : [];
  if (body.audience === 'selected' && !selected.length) throw new ApiError(400, 'Select at least one rider');
  const correctionOf = body.correctionOf ? objectId(body.correctionOf) : null;
  const requestHash = hash([text, date, body.audience, selected, correctionOf]);
  // Read together, checked in the original order: each read is a round trip.
  const [existing, original, enrollments] = await Promise.all([
    Announcement.findOne({ driverId: user._id, requestId: body.requestId }),
    correctionOf ? Announcement.exists({ _id: correctionOf, driverId: user._id }) : null,
    Enrollment.find({ driverId: user._id, status: 'ACTIVE', ...(selected.length ? { studentId: { $in: selected } } : {}) }).populate('studentId', 'accountId isActive'),
  ]);
  if (existing) { sameRequest(existing, requestHash); return existing; }
  if (correctionOf && !original) throw new ApiError(404, 'Original announcement not found');
  const active = enrollments.filter(e => e.studentId?.isActive);
  if (!active.length || (selected.length && selected.length !== active.length)) throw new ApiError(409, 'Audience changed. Refresh riders and review again.');
  // The preview freezes the audience. Never silently add new enrollments at send time.
  if (!Number.isInteger(body.recipientCount) || body.recipientCount !== active.length) throw new ApiError(409, 'Recipient count changed. Review the audience again.');
  if (body.audience === 'all' && (!Array.isArray(body.previewRiderIds) || hash([...body.previewRiderIds].sort()) !== hash(active.map(e => id(e.studentId)).sort()))) throw new ApiError(409, 'Audience changed. Review again.');
  const result = await upsert(Announcement, { driverId: user._id, requestId: body.requestId }, {
    driverId: user._id, requestId: body.requestId, requestHash, templateId: body.templateId || 'custom', parameters: body.parameters,
    text, date, audience: body.audience, correctionOf,
    recipients: active.map(e => ({ riderId: e.studentId._id, accountId: e.studentId.accountId, enrollmentId: e._id, state: 'pending' })),
  });
  sameRequest(result, requestHash);
  kickDispatcher();
  return result;
}
// Each read or write below is a round trip to the database (~230 ms in
// production). A pass used to make them one after another, about 8 per rider
// for a broadcast and 4 to 6 per message, so a 20-rider broadcast reached its
// last rider about a minute after it was sent. Each phase now costs a fixed
// handful of bulk reads and writes, whatever the number of riders.
const upsertOp = (filter, fields) => ({ updateOne: { filter, update: { $setOnInsert: fields }, upsert: true } });
// bulkWrite twin of upsert(): a duplicate key means another writer inserted the
// row first, which is what an upsert wants anyway. bulkWrite skips update
// validators; every field here comes from documents validated when written.
async function bulkUpsert(Model, ops) {
  if (!ops.length) return null;
  try { return await Model.bulkWrite(ops, { ordered: false }); } catch (error) {
    const failures = [].concat(error.writeErrors || []);
    if (!failures.length || failures.some(e => e.code !== 11000)) throw error;
    return error.result;
  }
}
async function deliverMessages(messages, io) {
  if (!messages.length) return;
  const threads = await Conversation.find({ _id: { $in: [...new Set(messages.map(m => id(m.conversationId)))] } }).lean();
  const threadById = new Map(threads.map(c => [id(c), c]));
  const notes = []; const pushes = []; const touched = new Map(); const delivered = [];
  for (const m of messages) {
    const c = threadById.get(id(m.conversationId));
    if (!c) continue;
    // `text`, `sender` and `absenceStatus` ride along so a client popup (or push
    // data) can show the real copy, e.g. "Driver acknowledged the absence change
    // for Amal on 2026-09-10.", without fetching the thread.
    const event = { eventId: m.eventId, conversationId: id(c), riderId: id(c.riderId), absenceId: m.absenceId, revision: m.revision, text: m.text, sender: m.sender, absenceStatus: m.absenceStatus };
    // Nothing written below changes the event, so it goes out first. Clients
    // dedupe on eventId, so a pass that fails after this and repeats it next
    // time costs nothing; notification:new follows once the rows exist.
    io?.to(`account:${c.accountId}`).to(`driver:${c.driverId}`).emit('communication:event', event);
    const roles = m.sender === 'system' ? (m.driverOnly ? ['driver'] : ['user', 'driver']) : [m.sender === 'driver' ? 'user' : 'driver'];
    for (const role of roles) {
      const recipientId = role === 'driver' ? c.driverId : c.accountId;
      const fields = { eventId: `${m.eventId}:${role}`, userId: recipientId, recipientRole: role,
        studentId: c.riderId, type: 'COMMUNICATION', title: role === 'driver' ? c.riderName : c.driverName,
        message: m.text, data: { ...event, type: 'COMMUNICATION', studentId: id(c.riderId) }, expiresAt: null };
      notes.push(fields);
      if (!m.announcementId) pushes.push({ eventId: fields.eventId, recipientId, role, title: fields.title, body: m.text, data: fields.data });
    }
    const at = touched.get(id(c));
    if (!at || m.createdAt > at) touched.set(id(c), m.createdAt);
    delivered.push(m._id);
  }
  const [stored] = await Promise.all([
    bulkUpsert(Notification, notes.map(fields => upsertOp({ eventId: fields.eventId }, fields))),
    bulkUpsert(PushDelivery, pushes.map(fields => upsertOp({ eventId: fields.eventId }, fields))),
    touched.size ? Conversation.bulkWrite([...touched].map(([_id, at]) => ({ updateOne: { filter: { _id }, update: { $max: { updatedAt: at } }, timestamps: false } }))) : null,
  ]);
  // bulkWrite fires no save hook, so new rows are announced here.
  for (const [index, _id] of Object.entries(stored?.upsertedIds || {})) notificationCreated({ ...notes[index], _id, createdAt: new Date() });
  if (delivered.length) await Message.updateMany({ _id: { $in: delivered } }, { $set: { deliveryPending: false } });
}
// One announcement's pending recipients, checked and written in bulk. Same
// outcome per recipient as before: skipped once no longer enrolled or active,
// failed when the driver is unavailable or the write fails.
async function fanOut(a) {
  const pending = a.recipients.filter(r => r.state === 'pending');
  if (!pending.length) return;
  const riderIds = pending.map(r => r.riderId);
  const [enrollments, riders, driver] = await Promise.all([
    Enrollment.find({ driverId: a.driverId, studentId: { $in: riderIds }, status: 'ACTIVE' }).select('_id studentId').lean(),
    Rider.find({ _id: { $in: riderIds }, isActive: true }).select('fullName accountId').lean(),
    Driver.findOne({ _id: a.driverId, isActive: { $ne: false } }).select('name').lean(),
  ]);
  const riderById = new Map(riders.map(r => [id(r), r]));
  const outcome = { sent: [], skipped: [], failed: [] };
  const deliverable = [];
  for (const r of pending) {
    const rider = riderById.get(id(r.riderId));
    const enrolled = enrollments.some(e => id(e.studentId) === id(r.riderId) && (!r.enrollmentId || id(e) === id(r.enrollmentId)));
    if (!enrolled || !rider) outcome.skipped.push(r._id);
    else if (!driver) outcome.failed.push(r._id);
    else deliverable.push({ r, rider });
  }
  if (deliverable.length) {
    try {
      await bulkUpsert(Conversation, deliverable.map(({ r, rider }) => upsertOp({ riderId: r.riderId, driverId: a.driverId },
        { riderId: r.riderId, driverId: a.driverId, accountId: rider.accountId, riderName: rider.fullName, driverName: driver.name })));
      const threads = await Conversation.find({ driverId: a.driverId, riderId: { $in: deliverable.map(d => d.r.riderId) } }).select('_id riderId').lean();
      const threadOf = new Map(threads.map(c => [id(c.riderId), c._id]));
      await bulkUpsert(Message, deliverable.filter(d => threadOf.has(id(d.r.riderId))).map(({ r }) => {
        const eventId = `announcement:${id(a)}:${id(r.riderId)}`;
        return upsertOp({ eventId }, { conversationId: threadOf.get(id(r.riderId)), eventId, sender: 'driver', text: a.text, templateId: a.templateId, announcementId: a._id, correctionOf: a.correctionOf });
      }));
      for (const { r } of deliverable) (threadOf.has(id(r.riderId)) ? outcome.sent : outcome.failed).push(r._id);
    } catch (e) { for (const { r } of deliverable) outcome.failed.push(r._id); }
  }
  const groups = Object.entries(outcome).filter(([, ids]) => ids.length);
  await Announcement.updateOne({ _id: a._id }, {
    $set: Object.fromEntries(groups.flatMap(([state]) => [[`recipients.$[${state}].state`, state], [`recipients.$[${state}].error`, state === 'failed' ? 'Delivery failed. Retry this recipient.' : '']])),
  }, { arrayFilters: groups.map(([state, ids]) => ({ [`${state}._id`]: { $in: ids }, [`${state}.state`]: 'pending' })) });
}
// One grouped push per account once no recipient is pending.
async function queueAnnouncementPush(a) {
  const latest = await Announcement.findById(a._id).lean();
  if (!latest || latest.pushQueued || latest.recipients.some(r => r.state === 'pending')) return;
  const accounts = new Map();
  for (const r of latest.recipients.filter(r => r.state === 'sent')) accounts.set(id(r.accountId), [...(accounts.get(id(r.accountId)) || []), r]);
  if (accounts.size) {
    const threads = await Conversation.find({ driverId: a.driverId, riderId: { $in: [...accounts.values()].map(list => list[0].riderId) } }).select('_id riderId').lean();
    const threadOf = new Map(threads.map(c => [id(c.riderId), c]));
    await bulkUpsert(PushDelivery, [...accounts].filter(([, list]) => threadOf.has(id(list[0].riderId))).map(([accountId, list]) => {
      const c = threadOf.get(id(list[0].riderId));
      const eventId = `announcement:${id(a)}:account:${accountId}`;
      return upsertOp({ eventId }, { eventId, recipientId: accountId, role: 'user',
        title: `Driver update${list.length > 1 ? ` · ${list.length} riders` : ''}`, body: a.text,
        data: { type: 'COMMUNICATION', eventId, conversationId: id(c), riderId: id(c.riderId), riderIds: list.map(r => id(r.riderId)) } });
    }));
  }
  await Announcement.updateOne({ _id: a._id }, { $set: { pushQueued: true } });
}
// Each absence change becomes a system message in the rider's thread.
async function writeTransitions() {
  const absences = await Absence.find({ 'history.pending': true }).limit(100).lean();
  const transitions = absences.flatMap(a => a.history.filter(h => h.pending).map(h => ({ a, h })));
  if (!transitions.length) return;
  // An _id minted here keeps two changes to one absence in order: an
  // unordered bulk write may apply them in any order, and threads sort by _id.
  await bulkUpsert(Message, transitions.map(({ a, h }) => upsertOp({ eventId: h.eventId }, { _id: new mongoose.Types.ObjectId(), eventId: h.eventId, conversationId: a.conversationId,
    sender: 'system', text: h.text, absenceId: a._id, revision: h.revision, absenceStatus: h.action, createdAt: h.at })));
  await Absence.bulkWrite(transitions.map(({ a, h }) => ({ updateOne: { filter: { _id: a._id, 'history.eventId': h.eventId }, update: { $set: { 'history.$.pending': false } } } })), { ordered: false });
}
// `retire` is false on most dispatcher passes: the sweep is a safety net, since
// ending an enrollment retires its absences directly. Sockets are served before
// the grouped pushes are queued, so a popup never waits on push bookkeeping.
async function dispatch(io, { retire = true } = {}) {
  if (retire) await retireAbsences();
  const [, announcements] = await Promise.all([
    writeTransitions(),
    Announcement.find({ $or: [{ 'recipients.state': 'pending' }, { pushQueued: false }] }).limit(50).lean(),
  ]);
  for (const a of announcements) await fanOut(a);
  await deliverMessages(await Message.find({ deliveryPending: true }).sort({ _id: 1 }).limit(200).lean(), io);
  for (const a of announcements) await queueAnnouncementPush(a);
}
const DISPATCH_INTERVAL_MS = 3000;
const RETIRE_SWEEP_MS = 60000;
let kick = null;
// Called right after a write that leaves something to deliver, so it goes out
// now instead of on the next interval. A no-op until startDispatcher runs
// (tests and scripts call dispatch() themselves).
function kickDispatcher() { kick?.(); }
// Delivery runs when kicked, and every interval as the safety net for anything
// a kick missed (a crash mid-pass, a write from another process). Push has its
// own loop, so a slow Expo call never holds up the socket.
function startDispatcher(io, { intervalMs = DISPATCH_INTERVAL_MS } = {}) {
  let busy = false; let again = false; let lastSweep = 0; let pushing = false;
  const push = async () => {
    if (pushing || mongoose.connection.readyState !== 1) return;
    pushing = true;
    try { await require('./communicationPush').dispatchPush(); }
    catch (error) { console.error('Communication push failed:', error.message); }
    finally { pushing = false; }
  };
  const tick = async (kicked = false) => {
    if (busy) { again = again || kicked; return; }
    if (mongoose.connection.readyState !== 1) return;
    busy = true;
    try {
      do {
        again = false;
        const retire = Date.now() - lastSweep >= RETIRE_SWEEP_MS;
        if (retire) lastSweep = Date.now();
        await dispatch(io, { retire });
      } while (again);
    } catch (error) { console.error('Communication dispatcher failed:', error.message); }
    finally { busy = false; void push(); }
  };
  kick = () => { void tick(true); };
  const timer = setInterval(tick, intervalMs); timer.unref();
  const pushTimer = setInterval(push, intervalMs); pushTimer.unref();
  void tick();
  return () => { clearInterval(timer); clearInterval(pushTimer); kick = null; };
}
module.exports = { id, objectId, requestId, upsert, ownedRider, activeEnrollment, thread, accessibleThread, send, transition, retireAbsences, audience, riderDetail, riderAvatar, announce, dispatch, startDispatcher, kickDispatcher };
