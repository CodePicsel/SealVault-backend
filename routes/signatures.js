// routes/signatures.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const auth = require('../middleware/auth');
const SignatureImage = require('../models/SignatureImage');
const { saveBuffer } = require('../helpers/storage');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB signature limit

// POST /api/signatures/upload  (multipart form-data: file)
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'File required' });
    const userId = req.user.id;
    const key = `signatures/${userId}/${Date.now()}-${req.file.originalname.replace(/\s+/g,'_')}`;

    const { storagePath, url } = await saveBuffer(req.file.buffer, key, req.file.mimetype);

    const sig = new SignatureImage({
      uploader: userId,
      originalName: req.file.originalname,
      storagePath,
      url,
      mimeType: req.file.mimetype,
      size: req.file.size
    });
    await sig.save();

    return res.status(201).json({ id: sig._id, originalName: sig.originalName, url: sig.url });
  } catch (err) {
    console.error('Signature upload error', err);
    return res.status(500).json({ message: 'Upload failed' });
  }
});

// GET /api/signatures  - list user's signature images
router.get('/', auth, async (req, res) => {
  try {
    const list = await SignatureImage.find({ uploader: req.user.id }).sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not fetch signatures' });
  }
});

module.exports = router;