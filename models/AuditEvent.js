const mongoose = require('mongoose');

const auditEventSchema = new mongoose.Schema({
  fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', required: true },
  signingRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'SigningRequest' },
  actorType: { type: String, enum: ['owner', 'signer', 'system'], required: true },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorSignerId: { type: mongoose.Schema.Types.ObjectId },
  actorEmail: { type: String, trim: true, lowercase: true },
  action: { type: String, required: true, trim: true, index: true },
  ip: { type: String },
  userAgent: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

auditEventSchema.index({ fileId: 1, createdAt: 1 });

module.exports = mongoose.model('AuditEvent', auditEventSchema);
