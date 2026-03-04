const crypto = require('crypto');

module.exports = (req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  const userAgent = req.headers['user-agent'] || '';
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';

  req.requestMeta = { requestId, ip, userAgent };
  res.setHeader('x-request-id', requestId);
  next();
};
