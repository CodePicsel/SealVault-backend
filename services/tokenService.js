const crypto = require('crypto');

const TOKEN_PEPPER = process.env.SIGN_TOKEN_PEPPER || process.env.JWT_SECRET || 'sealvault-sign-pepper';

function generateOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(`${TOKEN_PEPPER}:${rawToken}`).digest('hex');
}

module.exports = {
  generateOpaqueToken,
  hashToken
};
