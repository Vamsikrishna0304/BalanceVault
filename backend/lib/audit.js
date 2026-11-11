async function writeAuditLog(tx, { actorId, action, entityType, entityId, details, ipAddress }) {
  return tx.auditLog.create({
    data: {
      actorId: actorId || null,
      action,
      entityType,
      entityId: entityId || null,
      details: details || undefined,
      ipAddress: ipAddress || null,
    },
  });
}

module.exports = { writeAuditLog };
