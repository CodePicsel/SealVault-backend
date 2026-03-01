// routes/auth.js
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { check, validationResult } = require('express-validator');
const User = require('../models/User');

const {
  signAccessToken,
  createRefreshToken,
  addRefreshTokenToUser,
  removeRefreshToken,
  hashToken
} = require('../helpers/jwt');

const jwt = require('jsonwebtoken');
const router = express.Router();

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function setRefreshCookie(res, rawRefresh) {
  const maxAge = (parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS || '30', 10)) * 24 * 60 * 60 * 1000;
  res.cookie('refreshToken', rawRefresh, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge
  });
}

// REGISTER
router.post(
  '/register',
  [
    check('email', 'Validate email required').isEmail(),
    check('password', 'Password must be 8+ chars').isLength({ min: 8 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { email, password } = req.body;
      const existing = await User.findOne({ email });
      if (existing) return res.status(400).json({ message: 'Email already registered' });

      const user = new User({ email, password, provider: 'local', emailVerified: false });
      await user.save();

      const accessToken = signAccessToken(user._id.toString());
      const rawRefresh = createRefreshToken();
      await addRefreshTokenToUser(user._id, rawRefresh, req);
      setRefreshCookie(res, rawRefresh);

      return res.status(201).json({ token: accessToken, user: { id: user._id.toString(), email: user.email } });
    } catch (err) {
      console.error('Register error', err);
      return res.status(500).json({ message: 'Server error' });
    }
  }
);

// LOGIN
router.post(
  '/login',
  [
    check('email', 'Valid email required').isEmail(),
    check('password', 'Password is required').exists()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const { email, password } = req.body;
      const user = await User.findOne({ email });
      if (!user) return res.status(401).json({ message: 'Invalid credentials' });
      if (user.provider && user.provider !== 'local') {
        return res.status(400).json({
          message:
            'This account was created via Google Sign-In. Please use "Sign in with Google" or set a password.'
        });
      }
      const match = await user.comparePassword(password);
      if (!match) return res.status(401).json({ message: 'Invalid credentials' });
      const accessToken = signAccessToken(user._id.toString());
      const rawRefresh = createRefreshToken();
      await addRefreshTokenToUser(user._id, rawRefresh, req);
      setRefreshCookie(res, rawRefresh);
      return res.json({
        token: accessToken,
        user: { id: user._id.toString(), email: user.email, name: user.name }
      });
    } catch (err) {
      console.error('Login error', err);
      return res.status(500).json({ message: 'Server error' });
    }
  }
);

// GOOGLE OAUTH (ID token verifies)
router.post('/google', async (req, res) => {
  const { id_token } = req.body;
  if (!id_token) return res.status(400).json({ message: 'id_token required' });

  try {
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, email_verified, name } = payload;
    if (!email) return res.status(400).json({ message: 'Email not provided by Google' });

    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (user && user.provider === 'local' && !user.googleId) {
      return res.status(409).json({
        message: 'An account with this email already exists. Please sign in and link Google in account settings.'
      });
    }

    if (!user) {
      user = new User({ email, name, googleId, provider: 'google', emailVerified: !!email_verified });
      await user.save();
    } else {
      if (!user.googleId) {
        user.googleId = googleId;
        user.provider = 'google';
        user.emailVerified = user.emailVerified || !!email_verified;
      }
      user.lastLogin = new Date();
      await user.save();
    }

    const accessToken = signAccessToken(user._id.toString());
    const rawRefresh = createRefreshToken();
    await addRefreshTokenToUser(user._id, rawRefresh, req);
    setRefreshCookie(res, rawRefresh);

    return res.json({ token: accessToken, user: { id: user._id.toString(), email: user.email, name: user.name } });
  } catch (err) {
    console.error('Google auth error', err);
    return res.status(401).json({ message: 'Invalid Google token' });
  }
});

// REFRESH - rotate refresh token, return new access token
router.post('/refresh', async (req, res) => {
  try {
    const raw = req.cookies?.refreshToken;
    if (!raw) return res.status(401).json({ message: 'No refresh token' });

    const hashed = hashToken(raw);
    const user = await User.findOne({ 'refreshTokens.tokenHash': hashed });
    if (!user) return res.status(401).json({ message: 'Invalid refresh token' });

    const entry = user.refreshTokens.find((t) => t.tokenHash === hashed);
    if (!entry || new Date() > new Date(entry.expiresAt)) {
      await removeRefreshToken(user._id, raw).catch(() => {});
      return res.status(401).json({ message: 'Refresh token expired' });
    }

    // rotate
    const newRaw = createRefreshToken();
    await addRefreshTokenToUser(user._id, newRaw, req);
    await removeRefreshToken(user._id, raw);

    const accessToken = signAccessToken(user._id.toString());
    setRefreshCookie(res, newRaw);

    return res.json({ token: accessToken, user: { id: user._id.toString(), email: user.email, name: user.name } });
  } catch (err) {
    console.error('Refresh error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// LOGOUT
router.post('/logout', async (req, res) => {
  try {
    const raw = req.cookies?.refreshToken;
    if (raw) {
      await removeRefreshToken(null, raw).catch(() => {});
    }
    res.clearCookie('refreshToken', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    return res.json({ message: 'Logged out' });
  } catch (err) {
    console.error('Logout error', err);
    res.clearCookie('refreshToken');
    return res.json({ message: 'Logged out' });
  }
});

module.exports = router;