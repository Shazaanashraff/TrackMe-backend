// Compatibility facade for modules and integrations using the previous names.
const riders = require('./riders');

module.exports = {
  ...riders,
  ensureLegacyStudent: riders.ensureLegacyRider,
  findOwnedStudent: riders.findOwnedRider,
  effectiveGuardianPhone: riders.effectiveContactPhone,
  validGuardianPhone: riders.validContactPhone,
  publicStudent: riders.publicRider
};
