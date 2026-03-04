const { logAuditEvent } = require('../services/auditService');

module.exports = (req, res, next) => {
  req.logAudit = async (payload) => {
    const base = {
      ip: req.requestMeta?.ip || req.ip || '',
      userAgent: req.requestMeta?.userAgent || req.headers['user-agent'] || ''
    };
    return logAuditEvent({ ...base, ...payload });
  };
  next();
};
