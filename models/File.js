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

module.exports = mongoose.model('File', fileSchema);