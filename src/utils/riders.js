const RiderProfile = require('../models/RiderProfile');
const HouseholdPlace = require('../models/HouseholdPlace');
const { generateUniqueRiderCode } = require('./riderCode');

const PHONE_NUMBER_REGEX = /^[0-9+()\-\s]{7,20}$/;

async function ensureLegacyRider(account) {
  let rider = await RiderProfile.findOne({ accountId: account._id, isActive: { $ne: false } })
    .sort({ createdAt: 1 });
  if (rider) return rider;

  const riderCode = await generateUniqueRiderCode(RiderProfile);
  try {
    rider = await RiderProfile.create({
      _id: account._id,
      accountId: account._id,
      riderCode,
      fullName: account.name,
      avatarUrl: account.avatarUrl || '',
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

async function findOwnedRider(account, riderId, { includeInactive = false } = {}) {
  const resolvedId = riderId || (await ensureLegacyRider(account))._id;
  const filter = { _id: resolvedId, accountId: account._id };
  if (!includeInactive) filter.isActive = { $ne: false };
  return RiderProfile.findOne(filter);
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

function publicRider(rider, account) {
  return {
    _id: rider._id,
    riderCode: rider.riderCode,
    fullName: rider.fullName,
    guardianPhone: effectiveContactPhone(rider, account),
    contactPhone: effectiveContactPhone(rider, account),
    hasGuardianPhoneOverride: Boolean(rider.guardianPhoneOverride),
    avatarUrl: rider.avatarUrl || '',
    defaultPickupPlaceId: rider.defaultPickupPlaceId || null,
    defaultDropoffPlaceId: rider.defaultDropoffPlaceId || null,
    isActive: rider.isActive !== false,
    createdAt: rider.createdAt,
    updatedAt: rider.updatedAt
  };
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
  publicRider,
  mapValuesToObject
};
