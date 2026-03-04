const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
    originalName: { type: String, required: true },
    storagePath: { type: String, required: true }, // path/key inside bucket
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    url: { type: String },
    uploader: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now }
});

const signaturePlacementSchema = new mongoose.Schema({
  signatureImage: { type: mongoose.Schema.Types.ObjectId, ref: 'SignatureImage', required: true },
  page: { type: Number, required: true, default: 1 },
  // relative coords (fractions 0..1)
  xRel: { type: Number, required: true },   // fraction from left (0..1)
  yRel: { type: Number, required: true },   // fraction from top (0..1)
  widthRel: { type: Number, required: true }, // fraction of page width (0..1)
  heightRel: { type: Number }, // optional; if absent, server derives preserving aspect ratio
  rotation: { type: Number, default: 0 }, // degrees
  placedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});

const signedVersionSchema = new mongoose.Schema({
  storagePath: { type: String },
  url: { type: String }, // signed/served url
  createdAt: { type: Date, default: Date.now },
  placementsSnapshot: [signaturePlacementSchema] // snapshot of placements used for this signed version
});

// In your File schema:
fileSchema.add({
  signatures: [signaturePlacementSchema], // placements for this file
  signedVersions: [signedVersionSchema],
  activeSigningRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'SigningRequest' },
  signingStatus: {
    type: String,
    enum: ['none', 'in_progress', 'completed', 'cancelled', 'expired'],
    default: 'none'
  }
});

module.exports = mongoose.model('File', fileSchema);
