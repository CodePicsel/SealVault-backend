// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const RefreshTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  userAgent: { type: String },
  ip: { type: String }
});

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },
  password: {
    type: String,
    // required only when provider === 'local'
    required: function () {
      return (this.provider || 'local') === 'local';
    }
  },
  provider: { type: String, enum: ['local', 'google'], default: 'local' },
  googleId: { type: String, index: true, sparse: true },
  emailVerified: { type: Boolean, default: false },
  name: { type: String },
  refreshTokens: [RefreshTokenSchema],
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date }
});

// Async pre-save hook (promise style). DO NOT call next().
userSchema.pre('save', async function () {
  // `this` is the document
  if (!this.isModified('password') || !this.password) return;
  const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;
  const salt = await bcrypt.genSalt(saltRounds);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);