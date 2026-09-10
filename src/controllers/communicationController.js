const { Conversation, Message, Absence, Announcement } = require('../models/Communication');
const Rider = require('../models/RiderProfile');
const s = require('../services/communications');
const { today, validateDate, PRESETS } = require('../utils/communicationTemplates');
const { ApiError } = require('../middleware/errorHandler');
const handle = fn => async (req, res, next) => {
  try { res.json({ success: true, data: await fn(req) }); } catch (error) { next(error); }
};
const scope = user => ({ [user.role === 'driver' ? 'driverId' : 'accountId']: user._id });
const pageSize = req => Math.min(100, Math.max(1, Number(req.query.limit) || 50));
exports.presets = handle(() => ({ presets: PRESETS, today: today(), timezone: 'Asia/Colombo' }));
exports.audience = handle(req => s.audience(req.user, req.query.riderId));
exports.createThread = handle(req => s.thread(req.user, req.body.riderId, req.user.role === 'driver' ? s.id(req.user) : req.body.driverId));
exports.listThreads = handle(async req => {
  const filter = scope(req.user);
  if (req.query.riderId) {
    if (req.user.role === 'user') await s.ownedRider(req.user, req.query.riderId, false);
    filter.riderId = s.objectId(req.query.riderId);
  }
  const rows = await Conversation.find(filter).sort({ updatedAt: -1 }).lean();
  return Promise.all(rows.map(async c => {
    const readThrough = req.user.role === 'driver' ? c.driverReadThrough : c.userReadThrough;
    const unread = await Message.countDocuments({ conversationId: c._id, sender: { $ne: req.user.role }, ...(readThrough ? { _id: { $gt: readThrough } } : {}) });
    const rider = await Rider.findById(c.riderId).select('fullName riderCode avatarVersion').lean();
    return { ...c, rider, unread, preview: await Message.findOne({ conversationId: c._id }).sort({ _id: -1 }).lean(), readOnly: !await s.activeEnrollment(c.riderId, c.driverId) };
  }));
});
exports.messages = handle(async req => {
  const conversation = await s.accessibleThread(req.user, req.params.id);
  const filter = { conversationId: conversation._id };
  if (req.query.before) filter._id = { $lt: s.objectId(req.query.before) };
  const messages = await Message.find(filter).sort({ _id: -1 }).limit(pageSize(req)).lean();
  return { conversation, messages: messages.reverse(), nextCursor: messages.length === pageSize(req) ? s.id(messages[0]) : null,
    absences: await Absence.find({ conversationId: conversation._id }).lean(),
    readOnly: !await s.activeEnrollment(conversation.riderId, conversation.driverId) };
});
exports.send = handle(req => s.send(req.user, req.params.id, req.body));
exports.read = handle(async req => {
  const c = await s.accessibleThread(req.user, req.params.id);
  const through = s.objectId(req.body.throughMessageId);
  if (!await Message.exists({ _id: through, conversationId: c._id })) throw new ApiError(400, 'Message does not belong to this conversation');
  const field = req.user.role === 'driver' ? 'driverReadThrough' : 'userReadThrough';
  await Conversation.updateOne({ _id: c._id }, { $max: { [field]: through } }, { timestamps: false });
  req.app.get('io')?.to(`account:${c.accountId}`).to(`driver:${c.driverId}`).emit('communication:event', {
    eventId: `read:${s.id(c)}:${req.user.role}:${through}`, conversationId: s.id(c), riderId: s.id(c.riderId),
  });
  return { throughMessageId: through };
});
exports.report = handle(async req => {
  await s.ownedRider(req.user, req.body.riderId);
  validateDate(req.body.date); s.requestId(req.body.requestId);
  if (!Array.isArray(req.body.drivers) || !req.body.drivers.length || req.body.drivers.length > 50) throw new ApiError(400, 'Select 1–50 drivers');
  if (new Set(req.body.drivers.map(d => d.driverId)).size !== req.body.drivers.length) throw new ApiError(400, 'Duplicate drivers');
  const results = [];
  for (const driver of req.body.drivers) {
    try { results.push({ driverId: driver.driverId, success: true, absence: await s.transition(req.user, { ...req.body, driverId: driver.driverId, expectedRevision: driver.expectedRevision }, 'ABSENT') }); }
    catch (error) { if (!error.statusCode) throw error; results.push({ driverId: driver.driverId, success: false, status: error.statusCode, message: error.message }); }
  }
  return { results };
});
exports.cancel = handle(req => s.transition(req.user, req.body, 'CANCELLED', req.params.id));
exports.acknowledge = handle(req => s.transition(req.user, req.body, 'ACKNOWLEDGED', req.params.id));
exports.listAbsences = handle(async req => {
  const filter = scope(req.user);
  await s.retireAbsences(filter);
  if (req.query.riderId) {
    if (req.user.role === 'user') await s.ownedRider(req.user, req.query.riderId, false);
    filter.riderId = s.objectId(req.query.riderId);
  }
  if (req.query.date) filter.date = validateDate(req.query.date, false);
  else if (req.user.role === 'driver') filter.date = today();
  else filter.date = req.query.view === 'history' ? { $lt: today() } : { $gte: today() };
  const rows = await Absence.find(filter).sort({ date: 1, updatedAt: -1 })
    .populate('riderId', 'fullName riderCode avatarVersion').populate('driverId', 'name')
    .populate({ path: 'enrollmentId', populate: [{ path: 'pickupPlaceId', select: 'label address' }, { path: 'driverId', select: 'organization', populate: { path: 'organization', select: 'name' } }] }).lean();
  const changes = req.user.role === 'driver' ? await Absence.find({ driverId: req.user._id, date: { $gte: today() }, status: 'CANCELLED', $expr: { $lt: ['$acknowledgedRevision', '$revision'] } }).populate('riderId', 'fullName riderCode').sort({ date: 1, updatedAt: 1 }).lean() : [];
  return { rows, changes, absentCount: rows.filter(r => r.status === 'ABSENT').length, refreshedAt: new Date(), today: today() };
});
exports.announce = handle(req => s.announce(req.user, req.body));
exports.announcements = handle(req => Announcement.find({ driverId: req.user._id }).sort({ createdAt: -1 }).limit(100).lean());
exports.announcement = handle(async req => {
  const row = await Announcement.findOne({ _id: s.objectId(req.params.id), driverId: req.user._id });
  if (!row) throw new ApiError(404, 'Announcement not found');
  return row;
});
exports.retryAnnouncement = handle(async req => {
  const row = await Announcement.findOneAndUpdate({ _id: s.objectId(req.params.id), driverId: req.user._id }, {
    $set: { 'recipients.$[failed].state': 'pending', 'recipients.$[failed].error': '', pushQueued: false },
  }, { arrayFilters: [{ 'failed.state': 'failed' }], new: true });
  if (!row) throw new ApiError(404, 'Announcement not found');
  return row;
});
