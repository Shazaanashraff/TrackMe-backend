const RiderProfile = require('../models/RiderProfile');
const HouseholdPlace = require('../models/HouseholdPlace');
const { generateUniqueRiderCode } = require('./riderCode');

const PHONE_NUMBER_REGEX = /^[0-9+()\-\s]{7,20}$/;

// `seed` carries the category and details answered while the account was being
// created. It only ever applies to the row this function creates: an account that
// already has a rider keeps whatever that rider says.
async function ensureLegacyRider(account, seed = {}) {
  let rider = await RiderProfile.findOne({ accountId: account._id, isActive: { $ne: false } })
    .sort({ createdAt: 1 });
  if (rider) return rider;

  // `avatarUrl` is select:false on the account schemas, because it holds a base64
  // data URL that would otherwise ride along on every authenticated request, so
  // the doc handed in here carries none. This migration is the one place that
  // genuinely needs it, so read it back explicitly rather than losing the picture.
  let legacyAvatar = account.avatarUrl;
  if (legacyAvatar === undefined && typeof account.constructor?.findById === 'function') {
    const withAvatar = await account.constructor.findById(account._id).select('+avatarUrl').lean();
    legacyAvatar = withAvatar?.avatarUrl;
  }

  const riderCode = await generateUniqueRiderCode(RiderProfile);
  try {
    rider = await RiderProfile.create({
      _id: account._id,
      accountId: account._id,
      riderCode,
      fullName: account.name,
      avatarUrl: legacyAvatar || '',
      category: seed.category || null,
      details: seed.details && Object.keys(seed.details).length ? seed.details : undefined,
      qrTokenVersion: account.qrTokenVersion || 1,
      qrIssuedAt: account.qrIssuedAt || null,
      migratedFromLegacyUser: true
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    rider = await RiderProfile.findOne({ accountId: account._id, isActive: { $ne: false } })
      .sort({ createdAt: 1 });
  }
  return rider;
}

// `withAvatar` opts back into the select:false picture field; only the avatar
// endpoint wants the image itself.
async function findOwnedRider(account, riderId, { includeInactive = false, withAvatar = false } = {}) {
  const resolvedId = riderId || (await ensureLegacyRider(account))._id;
  const filter = { _id: resolvedId, accountId: account._id };
  if (!includeInactive) filter.isActive = { $ne: false };
  const query = RiderProfile.findOne(filter);
  return withAvatar ? query.select('+avatarUrl') : query;
}

async function assertOwnedPlaces(accountId, placeIds) {
  const ids = [...new Set((placeIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { valid: true, places: [] };
  const places = await HouseholdPlace.find({
    _id: { $in: ids },
    accountId,
    isActive: { $ne: false }
  });
  return { valid: places.length === ids.length, places };
}

function effectiveContactPhone(rider, account) {
  return String(rider.guardianPhoneOverride || account.phoneNumber || '').trim();
}

function validContactPhone(value) {
  return PHONE_NUMBER_REGEX.test(String(value || '').trim());
}

// The account holder's own rider row is created with `_id: account._id`
// (ensureLegacyRider), which is what makes "is this me, or someone I added?"
// answerable without a second field to keep in step.
function isSelfRider(rider, account) {
  return String(rider._id) === String(account._id);
}

// Whether each rider has a picture, without loading any picture. `avatarUrl` is
// select:false on RiderProfile (it holds a base64 data URL), so a document from
// find() carries no such field and `Boolean(rider.avatarUrl)` would read false
// for everyone. The aggregate sees the raw field, which is the same way the
// driver roster answers it (services/communications.js avatarFlags).
async function riderAvatarFlags(riderIds) {
  if (!riderIds.length) return new Map();
  const rows = await RiderProfile.aggregate([
    { $match: { _id: { $in: riderIds } } },
    { $project: { hasAvatar: { $gt: [{ $ifNull: ['$avatarUrl', ''] }, ''] } } }
  ]);
  return new Map(rows.map((row) => [String(row._id), Boolean(row.hasAvatar)]));
}

// `hasAvatar` must come from riderAvatarFlags unless the document was just
// written with the picture in memory (create, or a PATCH that set avatarUrl).
function publicRider(rider, account, hasAvatar) {
  const flag = hasAvatar !== undefined ? hasAvatar : rider.avatarUrl !== undefined ? Boolean(rider.avatarUrl) : false;
  return {
    _id: rider._id,
    riderCode: rider.riderCode,
    fullName: rider.fullName,
    category: rider.category || null,
    details: mapValuesToObject(rider.details),
    isSelf: isSelfRider(rider, account),
    guardianPhone: effectiveContactPhone(rider, account),
    contactPhone: effectiveContactPhone(rider, account),
    hasGuardianPhoneOverride: Boolean(rider.guardianPhoneOverride),
    // The picture itself is fetched one rider at a time (GET /api/riders/:id/avatar)
    // and cached by the client against `avatarVersion`. Inlining it here would put
    // every rider's image into every list response — the same reason managed
    // profiles keep theirs off their list (docs/modules/PROFILES.md).
    hasAvatar: flag,
    avatarVersion: rider.avatarVersion || 0,
    defaultPickupPlaceId: rider.defaultPickupPlaceId || null,
    defaultDropoffPlaceId: rider.defaultDropoffPlaceId || null,
    isActive: rider.isActive !== false,
    createdAt: rider.createdAt,
    updatedAt: rider.updatedAt
  };
}

async function publicRiders(riders, account) {
  const flags = await riderAvatarFlags(riders.map((rider) => rider._id));
  return riders.map((rider) => publicRider(rider, account, flags.get(String(rider._id)) || false));
}

function mapValuesToObject(values) {
  if (!values) return {};
  if (values instanceof Map || typeof values.entries === 'function') return Object.fromEntries(values.entries());
  if (typeof values === 'object') return { ...values };
  return {};
}

module.exports = {
  PHONE_NUMBER_REGEX,
  ensureLegacyRider,
  findOwnedRider,
  assertOwnedPlaces,
  effectiveContactPhone,
  validContactPhone,
  isSelfRider,
  riderAvatarFlags,
  publicRider,
  publicRiders,
  mapValuesToObject
};
