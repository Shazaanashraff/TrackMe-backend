// Organization lookup/creation shared by the super-admin console (which assigns
// managers to organizations) and the manager console (which picks one when
// creating a driver). Both must apply the same duplicate rules, so the rules
// live here rather than in either controller.
const Organization = require('../models/Organization');

const { ORG_SERVICE_TYPES } = Organization;

const normalizeServiceType = (value) => String(value || '').trim().toUpperCase();

const isOrgServiceType = (value) => ORG_SERVICE_TYPES.includes(normalizeServiceType(value));

const listOrganizations = async (serviceType) => {
  const filter = { isDeleted: false };
  const normalized = normalizeServiceType(serviceType);
  if (normalized) filter.serviceType = normalized;

  return Organization.find(filter)
    .sort({ name: 1 })
    .select('name serviceType isActive')
    .lean();
};

// Case-insensitive duplicate lookup within one service type. Collation
// strength:2 makes the exact-name match case-insensitive without regex escaping.
const findOrganizationByName = (name, serviceType) =>
  Organization.findOne({
    serviceType: normalizeServiceType(serviceType),
    name: String(name || '').trim(),
    isDeleted: false
  }).collation({ locale: 'en', strength: 2 });

// Resolves to { organization } on success, or { error: { status, message } }
// so callers can turn it straight into a response.
const createOrganization = async ({ name, serviceType, createdBy = null }) => {
  const trimmedName = String(name || '').trim();
  const normalizedType = normalizeServiceType(serviceType);

  if (!trimmedName) {
    return { error: { status: 400, message: 'Organization name is required' } };
  }

  if (!isOrgServiceType(normalizedType)) {
    return {
      error: {
        status: 400,
        message: 'Organizations only exist for school, university, or office services'
      }
    };
  }

  const existing = await findOrganizationByName(trimmedName, normalizedType);
  if (existing) {
    return {
      error: {
        status: 409,
        message: 'An organization with this name already exists for this service'
      }
    };
  }

  const organization = await Organization.create({
    name: trimmedName,
    serviceType: normalizedType,
    createdBy
  });

  return { organization };
};

const publicOrganization = (organization) =>
  organization
    ? {
      _id: organization._id,
      name: organization.name,
      serviceType: organization.serviceType
    }
    : null;

module.exports = {
  ORG_SERVICE_TYPES,
  normalizeServiceType,
  isOrgServiceType,
  listOrganizations,
  findOrganizationByName,
  createOrganization,
  publicOrganization
};
