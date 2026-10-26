const mongoose = require('mongoose');
const Identity = require('../models/Identity');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Manager = require('../models/Manager');
const RiderProfile = require('../models/RiderProfile');
const DriverEnrollment = require('../models/DriverEnrollment');
const HouseholdPlace = require('../models/HouseholdPlace');
const StudentOrganizationProfile = require('../models/StudentOrganizationProfile');
const Notification = require('../models/Notification');
const BoardingEvent = require('../models/BoardingEvent');
const Booking = require('../models/Booking');
const VehicleReview = require('../models/VehicleReview');
const { Conversation, Message, Absence, Announcement, PushDelivery } = require('../models/Communication');
const { findProfilesForIdentity } = require('../utils/identityRegistry');
const { revokeSessions } = require('../utils/sessions');
const { afterEnrollmentRemoved } = require('../utils/enrollmentExit');
const emails = require('../utils/accountEmails');

// Rider account deletion with a grace period.
//
// schedule  The rider confirms with an emailed code. Their household's PENDING
//           and ACTIVE enrollments end at once (the driver and manager are told),
//           every rider session ends, and `deletion.purgeAt` is set on the
//           PRIMARY profile.
// cancel    Signing in before `purgeAt` and choosing "Keep my account" puts the
//           enrollments back as they were and tells the driver and manager.
// purge     After `purgeAt` (hourly sweep, server start, or the person signing
//           in late) the household's personal data is deleted. Boarding events
//           stay for the operator's records, unlinked from the person.
//
// Only the rider side is removed. A login that also holds a driver or manager
// profile keeps its Identity, and those sessions are never touched.

const DEFAULT_GRACE_DAYS = 3;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const graceMs = () => {
  const raw = process.env.ACCOUNT_DELETION_GRACE_DAYS;
  const days = raw === undefined || String(raw).trim() === '' ? DEFAULT_GRACE_DAYS : Number(raw);
  return (Number.isFinite(days) && days >= 0 ? days : DEFAULT_GRACE_DAYS) * 24 * 60 * 60 * 1000;
};

const id = (value) => String(value?._id || value);

const isDue = (primary, now = Date.now()) =>
  Boolean(primary?.deletion?.purgeAt) && primary.deletion.purgeAt.getTime() <= now;

const householdOf = async (identityId) => {
  const users = await User.find({ identityId }).select('_id profileKind').lean();
  const userIds = users.map((u) => u._id);
  const riders = userIds.length
    ? await RiderProfile.find({ accountId: { $in: userIds } }).select('_id fullName accountId isActive').lean()
    : [];
  return { userIds, riders };
};

// --- Driver and manager notices -------------------------------------------

const noticeText = (kind, riderName, driverName, status) => {
  if (kind === 'RESTORED') {
    return status === 'PENDING'
      ? `${riderName} kept their account, so their request to join ${driverName}'s shuttle is back in your queue.`
      : `${riderName} is back on ${driverName}'s shuttle. They kept their account.`;
  }
  return status === 'PENDING'
    ? `${riderName} withdrew their request to join ${driverName}'s shuttle because they are deleting their account.`
    : `${riderName} left ${driverName}'s shuttle because they are deleting their account.`;
};

// The driver hears through the rider's chat thread (a system message, which the
// communications dispatcher also pushes). Only for ACTIVE enrollments: a
// pending request was never the driver's to see.
const tellDriver = async ({ enrollment, rider, driver, kind, stamp }) => {
  if (enrollment.status !== 'ACTIVE') return;
  const conversation = await Conversation.findOneAndUpdate(
    { riderId: rider._id, driverId: driver._id },
    { $setOnInsert: { riderId: rider._id, driverId: driver._id, accountId: rider.accountId, riderName: rider.fullName, driverName: driver.name } },
    { new: true, upsert: true }
  );
  const text = kind === 'RESTORED'
    ? `${rider.fullName} is back on your shuttle. They kept their account.`
    : `${rider.fullName} left your shuttle because they are deleting their account.`;
  const eventId = `account-${kind.toLowerCase()}:${id(enrollment)}:${stamp}`;
  await Message.updateOne(
    { eventId },
    { $setOnInsert: { conversationId: conversation._id, eventId, sender: 'system', driverOnly: true, text, deliveryPending: true } },
    { upsert: true }
  );
  require('./communications').kickDispatcher();
};

// The manager hears through the web-admin bell (a 'manager' Notification,
// announced on their socket by its save hook) and by email.
const tellManager = async ({ enrollment, rider, driver, kind }) => {
  const managerId = driver.managerId || enrollment.managerId;
  if (!managerId) return;
  const manager = await Manager.findById(managerId).select('name email').lean();
  if (!manager) return;

  const text = noticeText(kind, rider.fullName, driver.name, enrollment.status);
  await Notification.create({
    userId: manager._id,
    recipientRole: 'manager',
    studentId: rider._id,
    type: kind === 'RESTORED' ? 'RIDER_ACCOUNT_RESTORED' : 'RIDER_ACCOUNT_DELETED',
    title: kind === 'RESTORED' ? 'Rider is back' : 'Rider left',
    message: text,
    data: { relatedId: id(enrollment), riderId: id(rider), type: kind === 'RESTORED' ? 'RIDER_ACCOUNT_RESTORED' : 'RIDER_ACCOUNT_DELETED' }
  });
  if (manager.email) {
    await emails.sendManagerRiderNoticeEmail(manager.email, { managerName: manager.name, text, kind });
  }
};

// One failed notice must not stop the others, or the deletion itself.
const notifyAll = async (items, kind, stamp) => {
  if (!items.length) return;
  const drivers = await Driver.find({ _id: { $in: [...new Set(items.map(({ enrollment }) => id(enrollment.driverId)))] } })
    .select('name managerId')
    .lean();
  const driverById = new Map(drivers.map((d) => [id(d), d]));
  for (const { enrollment, rider } of items) {
    const driver = driverById.get(id(enrollment.driverId));
    if (!driver || !rider) continue;
    for (const tell of [tellDriver, tellManager]) {
      try {
        await tell({ enrollment, rider, driver, kind, stamp });
      } catch (error) {
        console.error(`Account deletion notice failed (${kind}):`, error.message);
      }
    }
  }
};

// --- schedule / cancel / purge ---------------------------------------------

const findPrimary = (identityId, select) => {
  const query = User.findOne({ identityId, profileKind: { $ne: 'MANAGED' } });
  return select ? query.select(select) : query;
};

const scheduleDeletion = async ({ identity, io }) => {
  const primary = await findPrimary(identity._id);
  if (!primary) return { error: { status: 404, message: 'Account not found' } };
  if (primary.deletion?.purgeAt) {
    return { error: { status: 409, code: 'ACCOUNT_PENDING_DELETION', message: 'This account is already scheduled for deletion.' } };
  }

  const requestedAt = new Date();
  const purgeAt = new Date(requestedAt.getTime() + graceMs());
  const { riders } = await householdOf(identity._id);
  const riderById = new Map(riders.map((r) => [id(r), r]));

  const enrollments = riders.length
    ? await DriverEnrollment.find({ studentId: { $in: riders.map((r) => r._id) }, status: { $in: ['PENDING', 'ACTIVE'] } }).lean()
    : [];

  // Written before anything is ended, so a crash part-way can still be undone
  // by "Keep my account": the snapshot is what restore reads.
  primary.deletion = { requestedAt, purgeAt, enrollmentSnapshot: enrollments };
  primary.pushTokens = [];
  await primary.save();

  if (enrollments.length) {
    await DriverEnrollment.deleteMany({ _id: { $in: enrollments.map((e) => e._id) } });
    for (const enrollment of enrollments) {
      try {
        await afterEnrollmentRemoved(enrollment, io);
      } catch (error) {
        console.error('Account deletion: ending an enrollment failed:', error.message);
      }
    }
  }

  await revokeSessions(identity._id, { roles: ['user'], io });
  await notifyAll(enrollments.map((enrollment) => ({ enrollment, rider: riderById.get(id(enrollment.studentId)) })), 'DELETED', requestedAt.getTime());
  await emails.sendDeletionScheduledEmail(identity.email, purgeAt);

  return { purgeAt };
};

const cancelDeletion = async ({ primary, identity, io }) => {
  const withSnapshot = await User.findById(primary._id).select('+deletion.enrollmentSnapshot');
  if (!withSnapshot?.deletion?.purgeAt) {
    return { error: { status: 409, code: 'NOT_PENDING_DELETION', message: 'This account is not scheduled for deletion.' } };
  }

  const snapshot = withSnapshot.deletion.enrollmentSnapshot || [];
  const [drivers, riders] = await Promise.all([
    Driver.find({ _id: { $in: [...new Set(snapshot.map((e) => id(e.driverId)))] }, isActive: { $ne: false } }).select('_id').lean(),
    RiderProfile.find({ _id: { $in: snapshot.map((e) => e.studentId) }, isActive: { $ne: false } }).select('_id fullName accountId').lean()
  ]);
  const liveDrivers = new Set(drivers.map(id));
  const riderById = new Map(riders.map((r) => [id(r), r]));

  // Put back exactly what was ended. A row is skipped when its driver or rider
  // is gone, or when the same rider and driver already have a row again.
  const restored = [];
  for (const row of snapshot) {
    if (!liveDrivers.has(id(row.driverId)) || !riderById.has(id(row.studentId))) continue;
    try {
      await DriverEnrollment.collection.insertOne(row);
      restored.push(row);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }

  withSnapshot.deletion = { requestedAt: null, purgeAt: null, enrollmentSnapshot: undefined };
  await withSnapshot.save();

  await notifyAll(restored.map((enrollment) => ({ enrollment, rider: riderById.get(id(enrollment.studentId)) })), 'RESTORED', Date.now());
  await emails.sendDeletionCancelledEmail(identity?.email || withSnapshot.email);

  return { user: withSnapshot, restoredCount: restored.length };
};

// Deletes the household's personal data. Safe to run twice: every step is a
// filter-based delete or update.
const purgeAccount = async (primary) => {
  const identityId = primary.identityId;
  const identity = identityId ? await Identity.findById(identityId).lean() : null;
  const email = identity?.email || primary.email;
  const { userIds, riders } = identityId ? await householdOf(identityId) : { userIds: [primary._id], riders: [] };
  const riderIds = riders.map((r) => r._id);

  if (email) await emails.sendAccountDeletedEmail(email);

  const conversationIds = await Conversation.find({ $or: [{ riderId: { $in: riderIds } }, { accountId: { $in: userIds } }] }).distinct('_id');

  await Promise.all([
    DriverEnrollment.deleteMany({ $or: [{ studentId: { $in: riderIds } }, { userId: { $in: userIds } }] }),
    StudentOrganizationProfile.deleteMany({ studentId: { $in: riderIds } }),
    HouseholdPlace.deleteMany({ accountId: { $in: userIds } }),
    // The rider's own inbox, and the driver's chat notifications about them.
    Notification.deleteMany({ recipientRole: { $ne: 'manager' }, $or: [{ userId: { $in: userIds } }, { studentId: { $in: riderIds } }] }),
    // The manager keeps the notice that a rider left, without who it was.
    Notification.updateMany(
      { recipientRole: 'manager', studentId: { $in: riderIds } },
      { $set: { studentId: null, message: 'A rider who left has now deleted their account. Their details were removed.' } }
    ),
    Message.deleteMany({ conversationId: { $in: conversationIds } }),
    Absence.deleteMany({ $or: [{ riderId: { $in: riderIds } }, { accountId: { $in: userIds } }] }),
    Announcement.updateMany({ 'recipients.riderId': { $in: riderIds } }, { $pull: { recipients: { riderId: { $in: riderIds } } } }),
    PushDelivery.deleteMany({ recipientId: { $in: userIds } }),
    Booking.deleteMany({ userId: { $in: userIds } }),
    VehicleReview.deleteMany({ userId: { $in: userIds } }),
    // Kept for the operator's attendance records; the rider row they point at
    // is deleted below, so only the location needs removing.
    BoardingEvent.updateMany({ studentId: { $in: riderIds } }, { $set: { lat: null, lng: null } })
  ]);

  await Conversation.deleteMany({ _id: { $in: conversationIds } });
  await RiderProfile.deleteMany({ _id: { $in: riderIds } });
  await User.deleteMany({ _id: { $in: userIds } });

  // The login goes only if it is no longer anyone else's way in.
  if (identityId && (await findProfilesForIdentity(identityId)).length === 0) {
    await Identity.deleteOne({ _id: identityId });
  }
};

const purgeDueAccounts = async (now = new Date()) => {
  const due = await User.find({ profileKind: { $ne: 'MANAGED' }, 'deletion.purgeAt': { $lte: now } });
  let purged = 0;
  for (const primary of due) {
    try {
      await purgeAccount(primary);
      purged += 1;
    } catch (error) {
      console.error(`Account purge failed for ${id(primary)}:`, error.message);
    }
  }
  return purged;
};

// Render's free tier sleeps when idle, so this runs on start (catching anything
// that came due while asleep) and then hourly while awake. Sign-in also purges
// a due account on the spot (authController), so nobody gets one back late.
const startDeletionSweeper = ({ intervalMs = SWEEP_INTERVAL_MS } = {}) => {
  let busy = false;
  const tick = async () => {
    if (busy || mongoose.connection.readyState !== 1) return;
    busy = true;
    try { await purgeDueAccounts(); }
    catch (error) { console.error('Account deletion sweep failed:', error.message); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, intervalMs); timer.unref();
  void tick();
  return () => clearInterval(timer);
};

module.exports = {
  graceMs,
  isDue,
  findPrimary,
  scheduleDeletion,
  cancelDeletion,
  purgeAccount,
  purgeDueAccounts,
  startDeletionSweeper
};
