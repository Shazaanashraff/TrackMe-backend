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
async function accessibleThread(user, conversationId, writable = false) {
  const conversation = await Conversation.findOne({ _id: objectId(conversationId), [user.role === 'driver' ? 'driverId' : 'accountId']: user._id });
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (writable && (!await activeEnrollment(conversation.riderId, conversation.driverId) || !await Rider.exists({ _id: conversation.riderId, isActive: true }))) throw new ApiError(403, 'Enrollment ended. History is read-only.');
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
  await accessibleThread(user, conversationId, true);
  return createMessage({ conversationId, eventId, requestHash, text, templateId: body.templateId || 'custom', sender: user.role });
}
function transitionText(name, date, action) {
  return action === 'ABSENT' ? `${name} will be absent on ${date}.`
    : action === 'CANCELLED' ? `${name} is coming on ${date}—absence cancelled.`
      : action === 'ACKNOWLEDGED' ? `Driver acknowledged the absence change for ${name} on ${date}.`
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
  if (action === 'ACKNOWLEDGED') {
    if (user.role !== 'driver' || driverId !== id(user)) throw new ApiError(404, 'Absence not found');
  } else await ownedRider(user, riderId, false);
  if (!existing) existing = await Absence.findOne({ riderId, driverId, date });
  const requestHash = hash([riderId, driverId, date, action, body.expectedRevision]);
  const replay = existing?.history.find(h => h.requestId === body.requestId);
  if (replay) { sameRequest(replay, requestHash); return existing; }
  validateDate(date);
  const enrollment = await activeEnrollment(riderId, driverId);
  if (!enrollment || !await Rider.exists({ _id: riderId, isActive: true })) throw new ApiError(403, 'Active enrollment is required');
  if ((existing?.revision || 0) !== body.expectedRevision) throw new ApiError(409, 'Absence changed. Refresh and review the latest revision.');
  if (action === 'ACKNOWLEDGED' && (existing?.status === 'RETIRED' || id(existing.enrollmentId) !== id(enrollment))) throw new ApiError(409, 'This notice is retired');
  if (action === 'CANCELLED' && existing?.status !== 'ABSENT') throw new ApiError(409, 'Only a current absence can be cancelled');
  if (action === 'ABSENT' && existing?.status === 'ABSENT' && id(existing.enrollmentId) === id(enrollment)) throw new ApiError(409, 'Rider is already absent on this date');
  const c = await thread(user, riderId, driverId);
  const revision = action === 'ACKNOWLEDGED' ? existing.revision : (existing?.revision || 0) + 1;
  const eventId = `absence:${id(c)}:${date}:${revision}:${action}`;
  const event = { eventId, requestId: body.requestId, requestHash, revision, action, text: transitionText(c.riderName, date, action), at: new Date(), pending: true };
  if (action === 'ACKNOWLEDGED' && existing.acknowledgedRevision === revision) return existing;
  const fields = action === 'ACKNOWLEDGED' ? { acknowledgedRevision: revision } : { status: action, revision, enrollmentId: enrollment._id };
  if (!existing) {
    try { return await Absence.create({ riderId, driverId, accountId: c.accountId, conversationId: c._id, date, ...fields, history: [event] }); }
    catch (error) { if (error.code !== 11000) throw error; }
  } else {
    const result = await Absence.findOneAndUpdate({ _id: existing._id, revision: body.expectedRevision, ...(action === 'ACKNOWLEDGED' ? { acknowledgedRevision: { $lt: revision } } : {}) }, { $set: fields, $push: { history: event } }, { new: true });
    if (result) return result;
  }
  const latest = await Absence.findOne({ riderId, driverId, date });
  const repeated = latest?.history.find(h => h.requestId === body.requestId);
  if (repeated) { sameRequest(repeated, requestHash); return latest; }
  throw new ApiError(409, 'Absence changed. Refresh and review the latest revision.');
}
async function retireAbsences(filter = {}) {
  const notices = await Absence.find({ ...filter, date: { $gte: today() }, status: { $ne: 'RETIRED' } });
  for (const a of notices) {
    if (await activeEnrollment(a.riderId, a.driverId, a.enrollmentId) && await Rider.exists({ _id: a.riderId, isActive: true })) continue;
    const c = await Conversation.findById(a.conversationId);
    const revision = a.revision + 1;
    await Absence.updateOne({ _id: a._id, revision: a.revision }, { $set: { status: 'RETIRED', revision }, $push: { history: {
      eventId: `absence:${id(a)}:${revision}:RETIRED`, revision, action: 'RETIRED', at: new Date(), pending: true, text: transitionText(c?.riderName || 'Rider', a.date, 'RETIRED'),
    } } });
  }
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
  const existing = await Announcement.findOne({ driverId: user._id, requestId: body.requestId });
  if (existing) { sameRequest(existing, requestHash); return existing; }
  if (correctionOf && !await Announcement.exists({ _id: correctionOf, driverId: user._id })) throw new ApiError(404, 'Original announcement not found');
  const enrollments = await Enrollment.find({ driverId: user._id, status: 'ACTIVE', ...(selected.length ? { studentId: { $in: selected } } : {}) }).populate('studentId', 'accountId isActive');
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
  sameRequest(result, requestHash); return result;
}
async function queuePush(fields) { return upsert(PushDelivery, { eventId: fields.eventId }, fields); }
async function deliverMessage(m, io) {
  const c = await Conversation.findById(m.conversationId);
  if (!c) return;
  // `text`/`sender`/`absenceStatus` ride along so a client banner (or push data
  // payload) can show the real copy — e.g. "Driver acknowledged the absence
  // change for Amal on 2026-09-10." — without a round-trip fetch of the thread.
  const event = { eventId: m.eventId, conversationId: id(c), riderId: id(c.riderId), absenceId: m.absenceId, revision: m.revision, text: m.text, sender: m.sender, absenceStatus: m.absenceStatus };
  const roles = m.sender === 'system' ? ['user', 'driver'] : [m.sender === 'driver' ? 'user' : 'driver'];
  for (const role of roles) {
    const recipientId = role === 'driver' ? c.driverId : c.accountId;
    const fields = { eventId: `${m.eventId}:${role}`, userId: recipientId, recipientRole: role,
      studentId: c.riderId, type: 'COMMUNICATION', title: role === 'driver' ? c.riderName : c.driverName,
      message: m.text, data: { ...event, type: 'COMMUNICATION', studentId: id(c.riderId) }, expiresAt: null };
    // upsert is a findOneAndUpdate, so the model's save hook does not fire here.
    notificationCreated(await upsert(Notification, { eventId: fields.eventId }, fields));
    if (!m.announcementId) await queuePush({ eventId: fields.eventId, recipientId, role, title: fields.title, body: m.text, data: fields.data });
  }
  await Conversation.updateOne({ _id: c._id }, { $max: { updatedAt: m.createdAt } }, { timestamps: false });
  io?.to(`account:${c.accountId}`).to(`driver:${c.driverId}`).emit('communication:event', event);
  await Message.updateOne({ _id: m._id }, { $set: { deliveryPending: false } });
}
async function dispatch(io) {
  await retireAbsences();
  for (const a of await Absence.find({ 'history.pending': true }).limit(100)) {
    for (const h of a.history.filter(h => h.pending)) {
      await createMessage({ eventId: h.eventId, conversationId: a.conversationId, sender: 'system', text: h.text,
        absenceId: a._id, revision: h.revision, absenceStatus: h.action, createdAt: h.at });
      await Absence.updateOne({ _id: a._id, 'history.eventId': h.eventId }, { $set: { 'history.$.pending': false } });
    }
  }
  for (const a of await Announcement.find({ $or: [{ 'recipients.state': 'pending' }, { pushQueued: false }] }).limit(50)) {
    for (const r of a.recipients.filter(r => r.state === 'pending')) {
      let state = 'sent'; let error;
      try {
        if (!await activeEnrollment(r.riderId, a.driverId, r.enrollmentId) || !await Rider.exists({ _id: r.riderId, isActive: true })) state = 'skipped';
        else {
          const c = await thread({ _id: a.driverId, role: 'driver' }, id(r.riderId), id(a.driverId));
          await createMessage({ conversationId: c._id, eventId: `announcement:${id(a)}:${id(r.riderId)}`, sender: 'driver', text: a.text, templateId: a.templateId, announcementId: a._id, correctionOf: a.correctionOf });
        }
      } catch (e) { state = 'failed'; error = 'Delivery failed. Retry this recipient.'; }
      await Announcement.updateOne({ _id: a._id, recipients: { $elemMatch: { _id: r._id, state: 'pending' } } }, { $set: { 'recipients.$.state': state, 'recipients.$.error': error || '' } });
    }
    const latest = await Announcement.findById(a._id);
    if (!latest.pushQueued && !latest.recipients.some(r => r.state === 'pending')) {
      for (const accountId of [...new Set(latest.recipients.filter(r => r.state === 'sent').map(r => id(r.accountId)))]) {
        const recipients = latest.recipients.filter(r => id(r.accountId) === accountId && r.state === 'sent');
        const c = await Conversation.findOne({ riderId: recipients[0].riderId, driverId: a.driverId });
        await queuePush({ eventId: `announcement:${id(a)}:account:${accountId}`, recipientId: accountId, role: 'user',
          title: `Driver update${recipients.length > 1 ? ` · ${recipients.length} riders` : ''}`, body: a.text,
          data: { type: 'COMMUNICATION', eventId: `announcement:${id(a)}:account:${accountId}`, conversationId: id(c), riderId: id(c.riderId), riderIds: recipients.map(r => id(r.riderId)) } });
      }
      await Announcement.updateOne({ _id: a._id }, { $set: { pushQueued: true } });
    }
  }
  for (const m of await Message.find({ deliveryPending: true }).sort({ _id: 1 }).limit(200)) await deliverMessage(m, io);
}
function startDispatcher(io) {
  let busy = false;
  const tick = async () => {
    if (busy || mongoose.connection.readyState !== 1) return;
    busy = true;
    try { await dispatch(io); await require('./communicationPush').dispatchPush(); }
    catch (error) { console.error('Communication dispatcher failed:', error.message); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 3000); timer.unref(); void tick();
  return () => clearInterval(timer);
}
module.exports = { id, objectId, requestId, upsert, ownedRider, activeEnrollment, thread, accessibleThread, send, transition, retireAbsences, audience, riderDetail, riderAvatar, announce, dispatch, startDispatcher };
