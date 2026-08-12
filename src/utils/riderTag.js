// Derives a display label for a rider profile's enrollment from the service
// type of the organization the driver belongs to — not stored on the profile
// itself. See docs/modules/PROFILES.md: storing a category on the profile
// would duplicate a fact that already lives on the Organization and go stale
// the moment a rider moves from a school shuttle to an office one. One User
// collection, no per-category fields, no per-category tables.
const SERVICE_TYPE_TAG = {
  SCHOOL: 'STUDENT',
  UNIVERSITY: 'STUDENT',
  OFFICE: 'EMPLOYEE'
};

// `serviceType` is the driver's Organization.serviceType, or null/undefined
// for a driver with none (a PUBLIC-service driver, or an enrollment whose
// driver record could not be resolved).
const riderTagForServiceType = (serviceType) => SERVICE_TYPE_TAG[serviceType] || 'PASSENGER';

module.exports = { riderTagForServiceType };
