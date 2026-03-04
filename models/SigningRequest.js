const mongoose = require('mongoose');

const signatureAssetSchema = new mongoose.Schema({
  storagePath: { type: String },
  url: { type: String },
  mimeType: { type: String },
  size: { type: Number },
  submittedAt: { type: Date }
}, { _id: false });

const signerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  order: { type: Number, required: true, min: 1 },
  status: {
    type: String,
    enum: ['pending', 'signed', 'declined', 'expired'],
    default: 'pending'
  },
  inviteTokenHash: { type: String, index: true },
  inviteTokenExpiresAt: { type: Date },
  inviteTokenConsumedAt: { type: Date },
  auditTokenHash: { type: String, index: true },
  auditTokenExpiresAt: { type: Date },
  signedAt: { type: Date },
  signedIp: { type: String },
  signedUserAgent: { type: String },
  signatureAsset: signatureAssetSchema
}, { _id: true });

const fieldSchema = new mongoose.Schema({
  signerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  type: { type: String, enum: ['signature'], default: 'signature' },
  page: { type: Number, required: true, min: 1 },
  xRel: { type: Number, required: true, min: 0, max: 1 },
  yRel: { type: Number, required: true, min: 0, max: 1 },
  widthRel: { type: Number, required: true, min: 0, max: 1 },
  heightRel: { type: Number, min: 0, max: 1 },
  required: { type: Boolean, default: true },
  signedAt: { type: Date }
}, { _id: true });

const signingRequestSchema = new mongoose.Schema({
  fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', required: true, index: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, trim: true },
  message: { type: String, trim: true },
  status: {
    type: String,
    enum: ['draft', 'in_progress', 'completed', 'cancelled', 'expired'],
    default: 'draft',
    index: true
  },
  expiresAt: { type: Date, required: true },
  signingMode: { type: String, enum: ['sequential'], default: 'sequential' },
  currentOrder: { type: Number, default: 1 },
  signers: { type: [signerSchema], default: [] },
  fields: { type: [fieldSchema], default: [] },
  finalPdfStoragePath: { type: String },
  finalPdfUrl: { type: String },
  completedAt: { type: Date }
}, { timestamps: true });

signingRequestSchema.index({ 'signers.inviteTokenHash': 1 });
signingRequestSchema.index({ 'signers.auditTokenHash': 1 });

module.exports = mongoose.model('SigningRequest', signingRequestSchema);
