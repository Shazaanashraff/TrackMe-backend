const Organization = require('../models/Organization');
const StudentOrganizationProfile = require('../models/StudentOrganizationProfile');
const { normalizedEnrollmentConfig, validateSchemaUpdate } = require('../utils/enrollmentSchema');

async function markIncompleteProfiles(organizationId, config) {
  const requiredKeys = config.fields.filter((field) => field.enabled && field.required).map((field) => field.key);
  const profiles = await StudentOrganizationProfile.find({ organizationId });
  await Promise.all(profiles.map(async (profile) => {
    const missing = requiredKeys.some((key) => !String(profile.values?.get?.(key) || '').trim());
    profile.needsUpdate = missing;
    if (!missing) profile.schemaVersion = config.schemaVersion;
    await profile.save();
  }));
}

function response(organization) {
  return {
    organization: { _id: organization._id, name: organization.name, serviceType: organization.serviceType },
    ...normalizedEnrollmentConfig(organization)
  };
}

async function saveSchema(organization, fields) {
  const validation = validateSchemaUpdate(organization.serviceType, fields);
  if (validation.error) return { error: validation.error };
  const current = normalizedEnrollmentConfig(organization);
  organization.enrollmentConfig = {
    schemaVersion: current.schemaVersion + 1,
    fields: validation.fields
  };
  await organization.save();
  const config = normalizedEnrollmentConfig(organization);
  await markIncompleteProfiles(organization._id, config);
  return { data: response(organization) };
}

exports.getManagerEnrollmentSchema = async (req, res, next) => {
  try {
    if (!req.user.organization) return res.status(404).json({ success: false, message: 'No organization is assigned to this manager' });
    const organization = await Organization.findOne({ _id: req.user.organization, isDeleted: false });
    if (!organization) return res.status(404).json({ success: false, message: 'Organization not found' });
    return res.status(200).json({ success: true, data: response(organization) });
  } catch (error) { next(error); }
};

exports.updateManagerEnrollmentSchema = async (req, res, next) => {
  try {
    if (!req.user.organization) return res.status(404).json({ success: false, message: 'No organization is assigned to this manager' });
    const organization = await Organization.findOne({ _id: req.user.organization, isDeleted: false });
    if (!organization) return res.status(404).json({ success: false, message: 'Organization not found' });
    const result = await saveSchema(organization, req.body?.fields);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true, data: result.data });
  } catch (error) { next(error); }
};

exports.getSuperAdminEnrollmentSchema = async (req, res, next) => {
  try {
    const organization = await Organization.findOne({ _id: req.params.organizationId, isDeleted: false });
    if (!organization) return res.status(404).json({ success: false, message: 'Organization not found' });
    return res.status(200).json({ success: true, data: response(organization) });
  } catch (error) { next(error); }
};

exports.updateSuperAdminEnrollmentSchema = async (req, res, next) => {
  try {
    const organization = await Organization.findOne({ _id: req.params.organizationId, isDeleted: false });
    if (!organization) return res.status(404).json({ success: false, message: 'Organization not found' });
    const result = await saveSchema(organization, req.body?.fields);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true, data: result.data });
  } catch (error) { next(error); }
};
