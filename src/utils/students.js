const StudentProfile = require('../models/StudentProfile');
const HouseholdPlace = require('../models/HouseholdPlace');
const { generateUniqueRiderCode } = require('./riderCode');

const PHONE_NUMBER_REGEX = /^[0-9+()\-\s]{7,20}$/;

async function ensureLegacyStudent(account) {
  let student = await StudentProfile.findOne({ accountId: account._id, isActive: { $ne: false } })
    .sort({ createdAt: 1 });
  if (student) return student;

  const riderCode = await generateUniqueRiderCode(StudentProfile);
  try {
    student = await StudentProfile.create({
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
    student = await StudentProfile.findOne({ accountId: account._id, isActive: { $ne: false } })
      .sort({ createdAt: 1 });
  }
  return student;
}

async function findOwnedStudent(account, studentId, { includeInactive = false } = {}) {
  const resolvedId = studentId || (await ensureLegacyStudent(account))._id;
  const filter = { _id: resolvedId, accountId: account._id };
  if (!includeInactive) filter.isActive = { $ne: false };
  return StudentProfile.findOne(filter);
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

function effectiveGuardianPhone(student, account) {
  return String(student.guardianPhoneOverride || account.phoneNumber || '').trim();
}

function validGuardianPhone(value) {
  return PHONE_NUMBER_REGEX.test(String(value || '').trim());
}

function publicStudent(student, account) {
  return {
    _id: student._id,
    riderCode: student.riderCode,
    fullName: student.fullName,
    guardianPhone: effectiveGuardianPhone(student, account),
    hasGuardianPhoneOverride: Boolean(student.guardianPhoneOverride),
    avatarUrl: student.avatarUrl || '',
    defaultPickupPlaceId: student.defaultPickupPlaceId || null,
    defaultDropoffPlaceId: student.defaultDropoffPlaceId || null,
    isActive: student.isActive !== false,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt
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
  ensureLegacyStudent,
  findOwnedStudent,
  assertOwnedPlaces,
  effectiveGuardianPhone,
  validGuardianPhone,
  publicStudent,
  mapValuesToObject
};
