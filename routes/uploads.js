const express = require('express');
const multer = require('multer')
const path = require('path');
const supabase = require('../config/supabase')
const File = require('../models/File')
const auth = require('../middleware/auth')

const router = express.Router();

const BUCKET = process.env.SUPABASE_BUCKET || 'user-files';
const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '10485760', 10);

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = file.mimetype === 'application/pdf' || ext === '.pdf';
    if (!allowed) return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  }
});

router.post('/pdf', auth, upload.single('file'), async(req, res)=>{
    try{
        if(!req.file) return res.status(400).json({message: 'FIle is required'});

        const userId = req.user.id;
        const timestamp = Date.now();
        const safeName = req.file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '');
        const key = `${userId}/${timestamp}-${Math.round(Math.random()*1e9)}-${safeName}`;
        const {data, error: uploadError} = await supabase.storage
        .from(BUCKET)
        .upload(key, req.file.buffer, {
            contentType: req.file.mimetype,
            upsert: false // set true if you want overwrite behavior
        });
        if (uploadError) {
            console.error('Supabase upload error:', uploadError);
            return res.status(500).json({ message: 'Failed to upload file' });
        }
        const expiresIn = 60 * 60; // 1 hour
        const { data: signedData, error: signedErr } = await supabase.storage
            .from(BUCKET)
            .createSignedUrl(key, expiresIn);

        if (signedErr) {
            console.warn('Signed URL creation failed:', signedErr);
        }
        const fileDoc = new File({
            originalName: req.file.originalname,
            storagePath: key,
            mimeType: req.file.mimetype,
            size: req.file.size,
            url: signedData?.signedUrl || null,
            uploader: userId
        });

        await fileDoc.save();
        res.status(201).json({
            id: fileDoc._id,
            originalName: fileDoc.originalName,
            size: fileDoc.size,
            mimeType: fileDoc.mimeType,
            url: fileDoc.url // may be null if signed creation failed
        });
    }catch (err) {
        console.error('Upload route error:', err);
        res.status(500).json({ message: err.message || 'Upload failed' });
    }
});

router.get('/', auth, async (req, res) => {
  try {
    const files = await File.find({ uploader: req.user.id }).sort({ createdAt: -1 }).lean();
    res.json(files);
  } catch (err) {
    console.error('Fetch files error:', err);
    res.status(500).json({ message: 'Could not fetch files' });
  }
});

router.get('/:id/download', auth, async (req, res) => {
  try {
    const fileDoc = await File.findById(req.params.id);
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });
    if (fileDoc.uploader.toString() !== req.user.id) return res.status(403).json({ message: 'Not authorized' });

    // create a signed url (expires in seconds)
    const expiresIn = 60 * 5; // 5 minutes
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(fileDoc.storagePath, expiresIn);
    if (error) {
      console.error('Signed url error:', error);
      return res.status(500).json({ message: 'Could not create signed URL' });
    }

    return res.json({ url: data?.signedUrl });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ message: 'Could not create download link' });
  }
});


module.exports = router;