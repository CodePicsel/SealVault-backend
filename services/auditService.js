const AuditEvent = require('../models/AuditEvent');

async function logAuditEvent(payload) {
  const doc = new AuditEvent({
    fileId: payload.fileId,
    signingRequestId: payload.signingRequestId,
    actorType: payload.actorType,
    actorUserId: payload.actorUserId,
    actorSignerId: payload.actorSignerId,
    actorEmail: payload.actorEmail,
    action: payload.action,
    ip: payload.ip || '',
    userAgent: payload.userAgent || '',
    metadata: payload.metadata || {}
  });
  return doc.save();
}

module.exports = {
  logAuditEvent
};
