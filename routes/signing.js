const express = require('express');
const rateLimit = require('express-rate-limit');

const File = require('../models/File');
const User = require('../models/User');
const signerTokenGuard = require('../middleware/signerTokenGuard');
const { resolveAssetUrl } = require('../services/fileAccess');
const { saveBuffer } = require('../helpers/storage');
const { composeFinalSignedPdf } = require('../services/pdfCompose');
const { sendMail } = require('../services/mailer');

const router = express.Router();

const publicSignerLimiter = rateLimit({
  windowMs: parseInt(process.env.SIGN_PUBLIC_RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.SIGN_PUBLIC_RATE_LIMIT_MAX || '30', 10),
  message: 'Too many signing requests, please try again later.'
});

function parseSignatureDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/png|image\/jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;

  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const rawBase64 = match[2].replace(/\s+/g, '');
  const buffer = Buffer.from(rawBase64, 'base64');
  if (!buffer.length) return null;

  return {
    mimeType,
    buffer,
    extension: mimeType.includes('png') ? 'png' : 'jpg'
  };
}

async function fetchWithFallback(url, options) {
  if (global.fetch) return global.fetch(url, options);
  const nodeFetch = await import('node-fetch');
  return nodeFetch.default(url, options);
}

async function resolveSignatureInput({ signatureImageBase64, signatureImageUrl }) {
  if (signatureImageBase64) return parseSignatureDataUrl(signatureImageBase64);
  if (!signatureImageUrl || typeof signatureImageUrl !== 'string') return null;

  const response = await fetchWithFallback(signatureImageUrl);
  if (!response.ok) return null;

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const mimeType = contentType.includes('png')
    ? 'image/png'
    : contentType.includes('jpeg') || contentType.includes('jpg')
      ? 'image/jpeg'
      : '';
  if (!mimeType) return null;

  const arr = await response.arrayBuffer();
  const buffer = Buffer.from(arr);
  if (!buffer.length) return null;

  return {
    mimeType,
    buffer,
    extension: mimeType.includes('png') ? 'png' : 'jpg'
  };
}

function getNextPendingOrder(signers) {
  return signers
    .filter((s) => s.status === 'pending')
    .map((s) => s.order)
    .sort((a, b) => a - b)[0];
}

async function sendCompletionEmails({ signingRequest, fileDoc, finalUrl }) {
  const owner = await User.findById(signingRequest.ownerUserId).lean();
  const recipients = new Set();
  if (owner?.email) recipients.add(owner.email);
  for (const signer of signingRequest.signers) recipients.add(signer.email);

  const subject = `Signing completed: ${signingRequest.title || fileDoc.originalName}`;
  const text = [
    'The document signing process is complete.',
    '',
    `File: ${fileDoc.originalName}`,
    `Download: ${finalUrl}`
  ].join('\n');

  const results = [];
  for (const email of recipients) {
    try {
      const result = await sendMail({ to: email, subject, text });
      results.push({ email, ok: true, mode: result.mode, messageId: result.messageId });
    } catch (err) {
      results.push({ email, ok: false, error: err.message || 'Email send failed' });
    }
  }
  return results;
}

router.get(
  '/:inviteToken',
  publicSignerLimiter,
  signerTokenGuard(),
  async (req, res, next) => {
    try {
      const signingRequest = req.signingRequest;
      const signer = req.signer;

      if (['cancelled', 'expired'].includes(signingRequest.status)) {
        return res.status(410).json({ message: `Signing request is ${signingRequest.status}` });
      }

      const fileDoc = await File.findById(signingRequest.fileId).lean();
      if (!fileDoc) return res.status(404).json({ message: 'File not found' });

      const fileUrl = await resolveAssetUrl({
        storagePath: fileDoc.storagePath,
        url: fileDoc.url
      }, 300);

      if (req.logAudit) {
        await req.logAudit({
          fileId: fileDoc._id,
          signingRequestId: signingRequest._id,
          actorType: 'signer',
          actorSignerId: signer._id,
          actorEmail: signer.email,
          action: 'SIGN_LINK_OPENED',
          metadata: {
            signerStatus: signer.status
          }
        });
      }

      const signerFields = signingRequest.fields.filter(
        (field) => field.signerId.toString() === signer._id.toString()
      );
      const pendingCount = signingRequest.signers.filter((s) => s.status === 'pending').length;

      return res.json({
        requestId: signingRequest._id,
        status: signingRequest.status,
        title: signingRequest.title,
        message: signingRequest.message,
        expiresAt: signingRequest.expiresAt,
        signer: {
          id: signer._id,
          name: signer.name,
          email: signer.email,
          status: signer.status,
          order: signer.order,
          isCurrentSigner: signer.status === 'pending' && signingRequest.currentOrder === signer.order
        },
        file: {
          id: fileDoc._id,
          originalName: fileDoc.originalName,
          url: fileUrl
        },
        fields: signerFields.map((field) => ({
          id: field._id,
          type: field.type,
          page: field.page,
          xRel: field.xRel,
          yRel: field.yRel,
          widthRel: field.widthRel,
          heightRel: field.heightRel,
          required: field.required,
          signedAt: field.signedAt
        })),
        sequence: {
          currentOrder: signingRequest.currentOrder,
          pendingCount,
          totalSigners: signingRequest.signers.length
        }
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  '/:inviteToken/sign',
  publicSignerLimiter,
  signerTokenGuard({ requireInProgress: true, requireCurrentOrder: true, requireUnconsumed: true }),
  async (req, res, next) => {
    try {
      const signingRequest = req.signingRequest;
      const signer = req.signer;
      const { signatureImageBase64, signatureImageUrl, consent } = req.body || {};

      if (consent !== true) {
        return res.status(422).json({ message: 'Explicit consent is required' });
      }

      if (signer.status !== 'pending') {
        return res.status(410).json({ message: `Signer status is ${signer.status}` });
      }

      const parsedSignature = await resolveSignatureInput({ signatureImageBase64, signatureImageUrl });
      if (!parsedSignature) {
        return res.status(422).json({
          message: 'Provide a valid signatureImageBase64 data URL or a public signatureImageUrl (PNG/JPEG)'
        });
      }

      const maxBytes = parseInt(process.env.SIGNATURE_MAX_BYTES || `${2 * 1024 * 1024}`, 10);
      if (parsedSignature.buffer.length > maxBytes) {
        return res.status(422).json({ message: `Signature image exceeds ${maxBytes} bytes` });
      }

      const signatureKey = `external-signatures/${signingRequest._id}/${signer._id}-${Date.now()}.${parsedSignature.extension}`;
      const storedSignature = await saveBuffer(
        parsedSignature.buffer,
        signatureKey,
        parsedSignature.mimeType
      );

      const now = new Date();
      signer.signatureAsset = {
        storagePath: storedSignature.storagePath,
        url: storedSignature.url,
        mimeType: parsedSignature.mimeType,
        size: parsedSignature.buffer.length,
        submittedAt: now
      };
      signer.status = 'signed';
      signer.signedAt = now;
      signer.signedIp = req.requestMeta?.ip || req.ip || '';
      signer.signedUserAgent = req.requestMeta?.userAgent || req.headers['user-agent'] || '';
      signer.inviteTokenConsumedAt = now;

      for (const field of signingRequest.fields) {
        if (field.signerId.toString() === signer._id.toString()) {
          field.signedAt = now;
        }
      }

      const allSigned = signingRequest.signers.every((s) => s.status === 'signed');
      if (!allSigned) {
        signingRequest.currentOrder = getNextPendingOrder(signingRequest.signers);
      }

      await signingRequest.save();

      const fileDoc = await File.findById(signingRequest.fileId);
      if (!fileDoc) return res.status(404).json({ message: 'File not found' });

      if (req.logAudit) {
        await req.logAudit({
          fileId: fileDoc._id,
          signingRequestId: signingRequest._id,
          actorType: 'signer',
          actorSignerId: signer._id,
          actorEmail: signer.email,
          action: 'SIGNED',
          metadata: {
            signerOrder: signer.order,
            signatureStoragePath: signer.signatureAsset.storagePath
          }
        });
      }

      if (!allSigned) {
        return res.json({
          message: 'Signature captured',
          status: signingRequest.status,
          signerStatus: signer.status,
          nextOrder: signingRequest.currentOrder
        });
      }

      try {
        const finalPdf = await composeFinalSignedPdf({ fileDoc, signingRequest });
        signingRequest.finalPdfStoragePath = finalPdf.storagePath;
        signingRequest.finalPdfUrl = finalPdf.url;
        signingRequest.status = 'completed';
        signingRequest.completedAt = new Date();
        await signingRequest.save();

        fileDoc.signingStatus = 'completed';
        fileDoc.activeSigningRequestId = signingRequest._id;
        
        // Push final signed document to signedVersions array
        fileDoc.signedVersions = fileDoc.signedVersions || [];
        fileDoc.signedVersions.push({
          storagePath: signingRequest.finalPdfStoragePath,
          url: signingRequest.finalPdfUrl,
          createdAt: new Date()
        });
        
        await fileDoc.save();

        const finalUrl = (await resolveAssetUrl({
          storagePath: signingRequest.finalPdfStoragePath,
          url: signingRequest.finalPdfUrl
        }, 3600)) || signingRequest.finalPdfUrl;
        if (!finalUrl) {
          throw new Error('Final PDF URL could not be resolved');
        }

        if (req.logAudit) {
          await req.logAudit({
            fileId: fileDoc._id,
            signingRequestId: signingRequest._id,
            actorType: 'system',
            action: 'FINALIZED',
            metadata: {
              finalPdfStoragePath: signingRequest.finalPdfStoragePath
            }
          });
        }

        const completionDeliveries = await sendCompletionEmails({
          signingRequest,
          fileDoc,
          finalUrl
        });

        if (req.logAudit) {
          for (const delivery of completionDeliveries) {
            await req.logAudit({
              fileId: fileDoc._id,
              signingRequestId: signingRequest._id,
              actorType: 'system',
              action: delivery.ok ? 'COMPLETION_EMAIL_SENT' : 'COMPLETION_EMAIL_FAILED',
              metadata: {
                email: delivery.email,
                mode: delivery.mode,
                messageId: delivery.messageId,
                error: delivery.error
              }
            });
          }
        }

        return res.json({
          message: 'Signature captured and workflow completed',
          status: signingRequest.status,
          finalPdfUrl: finalUrl,
          completionDeliveries
        });
      } catch (finalErr) {
        if (req.logAudit) {
          await req.logAudit({
            fileId: fileDoc._id,
            signingRequestId: signingRequest._id,
            actorType: 'system',
            action: 'FINALIZATION_FAILED',
            metadata: {
              error: finalErr.message || 'Unknown finalization error'
            }
          });
        }
        return res.status(500).json({
          message: 'Signature captured, but final PDF generation failed',
          error: finalErr.message || 'Unknown finalization error'
        });
      }
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
