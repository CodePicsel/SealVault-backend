// models/SignatureImage.js
const mongoose = require('mongoose');

const signatureImageSchema = new mongoose.Schema({
  uploader: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  originalName: { type: String },
  storagePath: { type: String }, // e.g. 'local/<name>' or supabase key
  url: { type: String },         // public or signed url to fetch image
  mimeType: { type: String },
  size: { type: Number },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SignatureImage', signatureImageSchema);