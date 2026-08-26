const ManagerAuditLog = require('../models/ManagerAuditLog');

// Extracted from managerController so every manager-scoped controller writes
// the audit trail the same way. Previously private to that one file, which is
// why a second controller needing it had no option but to duplicate it.
const writeAuditLog = async ({ managerId, actorId, actorRole, action, entityType, entityId, metadata }) => {
  await ManagerAuditLog.create({
    managerId,
    actorId,
    actorRole,
    action,
    entityType,
    entityId,
    metadata
  });
};

module.exports = { writeAuditLog };
