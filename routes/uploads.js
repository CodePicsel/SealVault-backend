// routes/uploads.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const supabase = require('../config/supabase'); // existing in your project
const File = require('../models/File');
const SignatureImage = require('../models/SignatureImage');
const SigningRequest = require('../models/SigningRequest');
const auth = require('../middleware/auth');
const { resolveAssetUrl } = require('../services/fileAccess');

// helper that tries supabase then local fallback (create as ../helpers/storage.js)
const { saveBuffer } = require('../helpers/storage');

const fetch = global.fetch || require('node-fetch');
const { PDFDocument } = require('pdf-lib');

const router = express.Router();

const BUCKET = process.env.SUPABASE_BUCKET || 'user-files';
const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '10485760', 10); // default 10MB

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

/**
 * POST /api/uploads/pdf
 * Upload PDF (authenticated)
 * Uses saveBuffer which attempts Supabase then local fallback.
 */
router.post('/pdf', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'File is required' });

    const userId = req.user.id;
    const timestamp = Date.now();
    const safeName = req.file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '');
    const key = `${userId}/${timestamp}-${Math.round(Math.random() * 1e9)}-${safeName}`;

    // saveBuffer will try Supabase (if configured) then local fallback
    const { storagePath, url, provider } = await saveBuffer(req.file.buffer, key, req.file.mimetype);

    // If we have Supabase available and url is null, try to create signed url
    let signedUrl = url;
    if (provider === 'supabase' && (!signedUrl || signedUrl === null) && supabase) {
      try {
        const expiresIn = 60 * 60; // 1 hour
        const { data: signedData, error: signedErr } = await supabase.storage.from(BUCKET).createSignedUrl(key, expiresIn);
        if (!signedErr && signedData?.signedUrl) signedUrl = signedData.signedUrl;
      } catch (e) {
        console.warn('Signed URL creation failed (non-fatal):', e?.message || e);
      }
    }

    const fileDoc = new File({
      originalName: req.file.originalname,
      storagePath: storagePath || key,
      mimeType: req.file.mimetype,
      size: req.file.size,
      url: signedUrl || (provider === 'local' ? `/uploads/${path.basename(storagePath || key)}` : null),
      uploader: userId,
      createdAt: new Date()
    });

    await fileDoc.save();

    return res.status(201).json({
      id: fileDoc._id,
      originalName: fileDoc.originalName,
      size: fileDoc.size,
      mimeType: fileDoc.mimeType,
      url: fileDoc.url
    });
  } catch (err) {
    console.error('Upload route error:', err);
    return res.status(500).json({ message: err.message || 'Upload failed' });
  }
});

/**
 * GET /api/uploads
 * List files for authenticated user
 */
router.get('/', auth, async (req, res) => {
  try {
    const files = await File.find({ uploader: req.user.id }).sort({ createdAt: -1 }).lean();
    res.json(files);
  } catch (err) {
    console.error('Fetch files error:', err);
    res.status(500).json({ message: 'Could not fetch files' });
  }
});

/**
 * GET /api/uploads/:id
 * Get file doc (including signedVersions)
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const fileDoc = await File.findById(req.params.id).lean();
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });
    if (fileDoc.uploader.toString() !== req.user.id) return res.status(403).json({ message: 'Not authorized' });
    res.json(fileDoc);
  } catch (err) {
    console.error('Get file error:', err);
    res.status(500).json({ message: 'Could not fetch file' });
  }
});

/**
 * GET /api/uploads/:id/final-download
 * Resolve a fresh URL for the latest final signed document.
 * Preference order:
 * 1) Completed signing workflow final PDF
 * 2) Latest file.signedVersions entry
 */
router.get('/:id/final-download', auth, async (req, res) => {
  try {
    const fileDoc = await File.findById(req.params.id).lean();
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });
    if (fileDoc.uploader.toString() !== req.user.id) return res.status(403).json({ message: 'Not authorized' });

    let asset = null;

    const latestCompletedRequest = await SigningRequest.findOne({
      fileId: fileDoc._id,
      status: 'completed'
    })
      .sort({ completedAt: -1, updatedAt: -1 })
      .lean();

    if (latestCompletedRequest && (latestCompletedRequest.finalPdfStoragePath || latestCompletedRequest.finalPdfUrl)) {
      asset = {
        storagePath: latestCompletedRequest.finalPdfStoragePath,
        url: latestCompletedRequest.finalPdfUrl
      };
    } else if (Array.isArray(fileDoc.signedVersions) && fileDoc.signedVersions.length > 0) {
      const latestSigned = fileDoc.signedVersions[fileDoc.signedVersions.length - 1];
      asset = {
        storagePath: latestSigned.storagePath,
        url: latestSigned.url
      };
    }

    if (!asset) {
      return res.status(404).json({ message: 'No final signed document found for this file' });
    }

    const url = await resolveAssetUrl(asset, 3600);
    if (!url) {
      return res.status(500).json({ message: 'Could not generate final download URL' });
    }

    return res.json({ url });
  } catch (err) {
    console.error('Final download error:', err);
    return res.status(500).json({ message: 'Could not create final download link' });
  }
});

/**
 * GET /api/uploads/:id/download
 * Create a short-lived signed download URL (Supabase) or return local URL
 */
router.get('/:id/download', auth, async (req, res) => {
  try {
    const fileDoc = await File.findById(req.params.id);
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });
    if (fileDoc.uploader.toString() !== req.user.id) return res.status(403).json({ message: 'Not authorized' });

    // If stored locally, return local path
    if (!fileDoc.storagePath) {
      // fallback to url if present
      return res.json({ url: fileDoc.url || null });
    }

    // If storagePath looks like local/<name> or url starts with /uploads/
    if (fileDoc.storagePath.startsWith('local/') || (fileDoc.url && fileDoc.url.startsWith('/uploads/'))) {
      // create public path from local filename
      const localName = (fileDoc.storagePath.startsWith('local/') ? fileDoc.storagePath.replace(/^local\//, '') : (fileDoc.url || '').replace(/^\/uploads\//, ''));
      const publicUrl = `/uploads/${localName}`;
      return res.json({ url: publicUrl });
    }

    // Otherwise attempt to create a Supabase signed URL
    if (supabase) {
      const expiresIn = 60 * 5; // 5 minutes
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(fileDoc.storagePath, expiresIn);
      if (error) {
        console.error('Signed url error:', error);
        // fallback to stored url property if any
        return res.json({ url: fileDoc.url || null });
      }
      return res.json({ url: data?.signedUrl });
    }

    // final fallback
    return res.json({ url: fileDoc.url || null });
  } catch (err) {
    console.error('Download error:', err);
    return res.status(500).json({ message: 'Could not create download link' });
  }
});

/**
 * POST /api/uploads/:id/signatures
 * Body JSON: { imageId, page, xRel, yRel, widthRel, heightRel?, rotation? }
 * Adds a placement to the File.signatures array
 */
router.post('/:id/signatures', auth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const { imageId, page, xRel, yRel, widthRel, heightRel, rotation } = req.body;

    if (!imageId || page == null || xRel == null || yRel == null || widthRel == null) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const fileDoc = await File.findById(fileId);
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });
    if (fileDoc.uploader.toString() !== req.user.id) return res.status(403).json({ message: 'Not authorized' });

    const sigImg = await SignatureImage.findById(imageId);
    if (!sigImg) return res.status(404).json({ message: 'Signature image not found' });
    if (sigImg.uploader.toString() !== req.user.id) return res.status(403).json({ message: 'Not authorized to use this signature' });

    const placement = {
      signatureImage: sigImg._id,
      page: Number(page),
      xRel: Number(xRel),
      yRel: Number(yRel),
      widthRel: Number(widthRel),
      heightRel: heightRel != null ? Number(heightRel) : undefined,
      rotation: rotation ? Number(rotation) : 0,
      placedBy: req.user.id,
      createdAt: new Date()
    };

    fileDoc.signatures = fileDoc.signatures || [];
    fileDoc.signatures.push(placement);
    await fileDoc.save();

    return res.status(201).json({ message: 'Signature placed', placement: fileDoc.signatures[fileDoc.signatures.length - 1] });
  } catch (err) {
    console.error('Add signature placement error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * POST /api/uploads/:id/apply-signatures
 * Composes placed signatures into a new signed PDF and saves it.
 * Returns signed file storage info.
 */
// --- replace existing handler with the following ---
router.post('/:id/apply-signatures', auth, async (req, res) => {
  try {
    const fileId = req.params.id;

    // load file doc (not .lean() because we update later)
    const fileDoc = await File.findById(fileId);
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });
    if (fileDoc.uploader.toString() !== req.user.id) return res.status(403).json({ message: 'Not authorized' });

    const placements = fileDoc.signatures || [];
    if (!placements.length) return res.status(400).json({ message: 'No signatures to apply' });

    // helper to fetch url -> arrayBuffer with meaningful error
    const tryFetchUrl = async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`Failed to fetch PDF: ${r.status}`);
      return await r.arrayBuffer();
    };

    // 1) Load original PDF bytes with a fresh signed-url attempt when necessary
    let pdfBytes;
    try {
      // local storage stored as 'local/<name>'
      if (fileDoc.storagePath && fileDoc.storagePath.startsWith('local/')) {
        const localName = fileDoc.storagePath.replace(/^local\//, '');
        const fp = path.join(process.cwd(), 'uploads', localName);
        if (!fs.existsSync(fp)) throw new Error('Local PDF missing');
        pdfBytes = fs.readFileSync(fp);
      } else if (fileDoc.url && fileDoc.url.startsWith('/uploads/')) {
        // URL references local file served by express
        const localName = fileDoc.url.replace(/^\/uploads\//, '');
        const fp = path.join(process.cwd(), 'uploads', localName);
        if (!fs.existsSync(fp)) throw new Error('Local PDF missing');
        pdfBytes = fs.readFileSync(fp);
      } else if (fileDoc.storagePath && supabase) {
        // Prefer generating a fresh signed URL to avoid expired saved urls
        try {
          const expiresIn = 60 * 5; // 5 minutes
          const { data: signedData, error: signedErr } = await supabase.storage.from(BUCKET).createSignedUrl(fileDoc.storagePath, expiresIn);
          if (!signedErr && signedData?.signedUrl) {
            pdfBytes = await tryFetchUrl(signedData.signedUrl);
          } else {
            // fallback to stored url if present
            if (fileDoc.url) {
              pdfBytes = await tryFetchUrl(fileDoc.url);
            } else {
              throw new Error('Unable to retrieve original PDF (signed URL creation failed)');
            }
          }
        } catch (e) {
          // final fallback to stored fileDoc.url
          if (fileDoc.url) {
            pdfBytes = await tryFetchUrl(fileDoc.url);
          } else {
            throw e;
          }
        }
      } else if (fileDoc.url) {
        // try stored url (may be expired)
        pdfBytes = await tryFetchUrl(fileDoc.url);
      } else {
        throw new Error('No method to load original PDF');
      }
    } catch (err) {
      console.error('Load original PDF error for fileId=', fileId, err.message || err);
      return res.status(500).json({ message: 'Signing failed', error: err.message || String(err) });
    }

    // 2) Compose PDF with pdf-lib
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // cache embedded images by signature image id
    const imageCache = new Map();

    for (const placement of placements) {
      const sigId = placement.signatureImage;
      if (!sigId) {
        console.warn('Skipping placement with no signatureImage', placement);
        continue;
      }

      const sig = await SignatureImage.findById(sigId).lean();
      if (!sig) {
        console.warn('Signature image missing for id', sigId);
        continue;
      }

      // fetch signature image bytes (support local or remote similar to PDF logic)
      let imageBytes;
      try {
        if (sig.storagePath && sig.storagePath.startsWith('local/')) {
          const localName = sig.storagePath.replace(/^local\//, '');
          const fp = path.join(process.cwd(), 'uploads', localName);
          if (!fs.existsSync(fp)) throw new Error('Signature image missing on disk');
          imageBytes = fs.readFileSync(fp);
        } else if (sig.url && sig.url.startsWith('/uploads/')) {
          const localName = sig.url.replace(/^\/uploads\//, '');
          const fp = path.join(process.cwd(), 'uploads', localName);
          if (!fs.existsSync(fp)) throw new Error('Signature image missing on disk');
          imageBytes = fs.readFileSync(fp);
        } else if (sig.url) {
          const r = await fetch(sig.url);
          if (!r.ok) throw new Error(`Failed to fetch signature image: ${r.status}`);
          imageBytes = await r.arrayBuffer();
        } else if (sig.storagePath && supabase) {
          const expiresIn = 60 * 5;
          const { data: signedData, error: signedErr } = await supabase.storage.from(BUCKET).createSignedUrl(sig.storagePath, expiresIn);
          if (!signedErr && signedData?.signedUrl) {
            const r = await fetch(signedData.signedUrl);
            if (!r.ok) throw new Error(`Failed to fetch signature image: ${r.status}`);
            imageBytes = await r.arrayBuffer();
          } else {
            throw new Error('Could not obtain signature image URL');
          }
        } else {
          throw new Error('No method to retrieve signature image');
        }
      } catch (e) {
        console.warn('Skipping signature image due to fetch error', sigId, e.message || e);
        continue;
      }

      // embed image once
      const key = sig._id.toString();
      if (!imageCache.has(key)) {
        const buffer = imageBytes instanceof Buffer ? imageBytes : Buffer.from(imageBytes);
        let embedded;
        if (sig.mimeType && sig.mimeType.includes('png')) {
          embedded = await pdfDoc.embedPng(buffer);
        } else {
          embedded = await pdfDoc.embedJpg(buffer);
        }
        imageCache.set(key, { embedded, dim: { width: embedded.width, height: embedded.height } });
      }
    }

    // 3) Draw placements onto pages
    for (const placement of placements) {
      const pageIndex = Math.max(0, Number(placement.page) - 1);
      if (pageIndex >= pdfDoc.getPageCount()) {
        console.warn('Placement page out of range', placement);
        continue;
      }
      const pdfPage = pdfDoc.getPage(pageIndex);
      const { width: pageWidth, height: pageHeight } = pdfPage.getSize();

      const cacheKey = placement.signatureImage.toString();
      const cached = imageCache.get(cacheKey);
      if (!cached) continue;
      const { embedded, dim } = cached;

      const targetWidth = (placement.widthRel || 0.2) * pageWidth;
      let targetHeight;
      if (placement.heightRel) {
        targetHeight = placement.heightRel * pageHeight;
      } else {
        const aspect = dim.height / dim.width;
        targetHeight = targetWidth * aspect;
      }

      const x = placement.xRel * pageWidth;
      const yTop = placement.yRel * pageHeight;
      const y = pageHeight - yTop - targetHeight;

      if (placement.rotation && Number(placement.rotation) !== 0) {
        const radians = (Number(placement.rotation) * Math.PI) / 180;
        pdfPage.drawImage(embedded, { x, y, width: targetWidth, height: targetHeight, rotate: radians });
      } else {
        pdfPage.drawImage(embedded, { x, y, width: targetWidth, height: targetHeight });
      }
    }

    // 4) Save the composed PDF and persist via saveBuffer
    const newPdfBytes = await pdfDoc.save();
    const signedKey = `signed/${fileDoc.uploader}/${Date.now()}-signed-${path.basename(fileDoc.originalName || ('file-' + fileId))}`;
    const { storagePath: signedStoragePath, url: signedUrl } = await saveBuffer(Buffer.from(newPdfBytes), signedKey, 'application/pdf');

    // 5) Update File document with signed version (push snapshot)
    const placementsSnapshot = (fileDoc.signatures || []).map(pl => ({ ...pl }));
    fileDoc.signedVersions = fileDoc.signedVersions || [];
    fileDoc.signedVersions.push({ storagePath: signedStoragePath, url: signedUrl, placementsSnapshot, createdAt: new Date() });
    await fileDoc.save();

    return res.status(201).json({
      message: 'Signed PDF created',
      signed: { storagePath: signedStoragePath, url: signedUrl },
      file: fileDoc
    });
  } catch (err) {
    console.error('Apply signatures error', err);
    return res.status(500).json({ message: 'Signing failed', error: err?.message || String(err) });
  }
});

module.exports = router;
