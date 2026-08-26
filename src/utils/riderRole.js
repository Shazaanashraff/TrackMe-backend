const ROLE_BY_SERVICE_TYPE = Object.freeze({
  SCHOOL: 'student',
  UNIVERSITY: 'student',
  OFFICE: 'employee'
});

// This is only called after a driver key has been resolved. A resolved driver
// without an organization-specific role is a passenger; an unresolved profile
// remains the neutral "rider" in account-facing UI.
function riderRoleForResolvedService(serviceType) {
  return ROLE_BY_SERVICE_TYPE[serviceType] || 'passenger';
}

module.exports = { riderRoleForResolvedService };
