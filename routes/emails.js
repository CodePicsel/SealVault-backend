const express = require('express');
const mongoose = require('mongoose');

const auth = require('../middleware/auth');
const File = require('../models/File');
const SigningRequest = require('../models/SigningRequest');
const { sendMail } = require('../services/mailer');
const { resolveAssetUrl } = require('../services/fileAccess');

const router = express.Router();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

router.post('/files/:fileId/share', auth, async (req, res, next) => {
  try {
    const fileId = req.params.fileId;
    if (!mongoose.Types.ObjectId.isValid(fileId)) {
      return res.status(422).json({ message: 'Invalid fileId' });
    }

    const toList = Array.isArray(req.body?.to) ? req.body.to.map(normalizeEmail).filter(Boolean) : [];
    const subject = req.body?.subject ? String(req.body.subject).trim() : '';
    const message = req.body?.message ? String(req.body.message).trim() : '';
    const version = req.body?.version === 'final' ? 'final' : 'original';

    if (!toList.length) return res.status(422).json({ message: 'to must contain at least one recipient' });
    if (!subject) return res.status(422).json({ message: 'subject is required' });

    const fileDoc = await File.findById(fileId);
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });
    if (fileDoc.uploader.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    let signingRequest = null;
    let shareAsset = { storagePath: fileDoc.storagePath, url: fileDoc.url };

    if (version === 'final') {
      signingRequest = await SigningRequest.findOne({
        fileId,
        status: 'completed'
      }).sort({ completedAt: -1 });
      if (!signingRequest || (!signingRequest.finalPdfStoragePath && !signingRequest.finalPdfUrl)) {
        return res.status(409).json({ message: 'No completed final signed PDF available for this file' });
      }
      shareAsset = {
        storagePath: signingRequest.finalPdfStoragePath,
        url: signingRequest.finalPdfUrl
      };
    }

    const shareUrl = await resolveAssetUrl(shareAsset, 3600);
    if (!shareUrl) return res.status(500).json({ message: 'Could not create share link' });

    const deliveries = [];
    for (const email of toList) {
      const text = [message || 'Please find your document.', '', `Link: ${shareUrl}`].join('\n');
      try {
        const result = await sendMail({
          to: email,
          subject,
          text
        });
        deliveries.push({
          email,
          ok: true,
          mode: result.mode,
          messageId: result.messageId
        });
      } catch (err) {
        deliveries.push({
          email,
          ok: false,
          error: err.message || 'Email send failed'
        });
      }
    }

    if (req.logAudit) {
      for (const delivery of deliveries) {
        await req.logAudit({
          fileId: fileDoc._id,
          signingRequestId: signingRequest?._id,
          actorType: 'owner',
          actorUserId: req.user.id,
          action: delivery.ok ? 'FILE_SHARED_EMAIL_SENT' : 'FILE_SHARED_EMAIL_FAILED',
          metadata: {
            version,
            email: delivery.email,
            mode: delivery.mode,
            messageId: delivery.messageId,
            error: delivery.error
          }
        });
      }
    }

    const sent = deliveries.filter((d) => d.ok).length;
    const failed = deliveries.length - sent;
    return res.json({
      fileId: fileDoc._id,
      version,
      shareUrl,
      summary: { total: deliveries.length, sent, failed },
      deliveries
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
