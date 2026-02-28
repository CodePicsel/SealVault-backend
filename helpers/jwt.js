// helpers/jwt.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '1h';
const REFRESH_TOKEN_EXPIRES_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS || '30', 10);

function signAccessToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function createRefreshToken() {
  return crypto.randomBytes(48).toString('hex'); // opaque raw token
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function addRefreshTokenToUser(userId, rawRefreshToken, req = {}) {
  const tokenHash = hashToken(rawRefreshToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

  const meta = {
    tokenHash,
    createdAt: now,
    expiresAt,
    userAgent: req.headers?.['user-agent'] || '',
    ip: req.ip || (req.headers && req.headers['x-forwarded-for']) || ''
  };

  // push into refreshTokens array
  await User.findByIdAndUpdate(userId, { $push: { refreshTokens: meta } }, { new: true }).exec();
}

async function removeRefreshToken(userId, rawRefreshToken) {
  const tokenHash = hashToken(rawRefreshToken);
  if (userId) {
    await User.findByIdAndUpdate(userId, { $pull: { refreshTokens: { tokenHash } } }).exec();
  } else {
    await User.updateMany({}, { $pull: { refreshTokens: { tokenHash } } }).exec();
  }
}

async function removeAllRefreshTokens(userId) {
  await User.findByIdAndUpdate(userId, { $set: { refreshTokens: [] } }).exec();
}

module.exports = {
  signAccessToken,
  createRefreshToken,
  hashToken,
  addRefreshTokenToUser,
  removeRefreshToken,
  removeAllRefreshTokens
};