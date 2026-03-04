const express = require('express');
const mongoose = require('mongoose');

const auth = require('../middleware/auth');
const File = require('../models/File');
const SigningRequest = require('../models/SigningRequest');
const { sendMail } = require('../services/mailer');
const { generateOpaqueToken, hashToken } = require('../services/tokenService');

const router = express.Router();

const SIGNING_LINK_BASE_URL = (
  process.env.SIGNING_LINK_BASE_URL ||
  process.env.APP_BASE_URL ||
  process.env.CLIENT_ORIGIN ||
  'http://localhost:5173'
).replace(/\/$/, '');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isFraction(value) {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function validateCreateBody(body) {
  const errors = [];
  const signers = Array.isArray(body.signers) ? body.signers : [];
  const fields = Array.isArray(body.fields) ? body.fields : [];

  if (!body.fileId || !mongoose.Types.ObjectId.isValid(body.fileId)) {
    errors.push('fileId is required and must be a valid ObjectId');
  }

  if (!signers.length) errors.push('At least one signer is required');
  if (!fields.length) errors.push('At least one field is required');

  const seenEmails = new Set();
  const seenOrders = new Set();
  for (const signer of signers) {
    const email = normalizeEmail(signer.email);
    const orderValue = Number(signer.order);
    if (!email) errors.push('Each signer must include email');
    if (!signer.name || !String(signer.name).trim()) errors.push('Each signer must include name');
    if (!Number.isInteger(orderValue) || orderValue < 1) errors.push('Each signer order must be an integer >= 1');
    if (seenEmails.has(email)) errors.push(`Duplicate signer email: ${email}`);
    if (seenOrders.has(orderValue)) errors.push(`Duplicate signer order: ${orderValue}`);
    seenEmails.add(email);
    seenOrders.add(orderValue);
  }

  for (const field of fields) {
    const signerEmail = normalizeEmail(field.signerEmail);
    const pageValue = Number(field.page);
    const xRel = Number(field.xRel);
    const yRel = Number(field.yRel);
    const widthRel = Number(field.widthRel);
    const heightRel = field.heightRel == null ? undefined : Number(field.heightRel);

    if (!signerEmail || !seenEmails.has(signerEmail)) {
      errors.push(`Field signerEmail is invalid: ${field.signerEmail || ''}`);
    }
    if (!Number.isInteger(pageValue) || pageValue < 1) errors.push('Field page must be an integer >= 1');
    if (!isFraction(xRel)) errors.push('Field xRel must be in range [0,1]');
    if (!isFraction(yRel)) errors.push('Field yRel must be in range [0,1]');
    if (!isFraction(widthRel) || widthRel === 0) errors.push('Field widthRel must be in range (0,1]');
    if (heightRel != null && (!isFraction(heightRel) || heightRel === 0)) {
      errors.push('Field heightRel must be in range (0,1] when provided');
    }
  }

  const expiresAt = new Date(body.expiresAt);
  if (!body.expiresAt || Number.isNaN(expiresAt.getTime())) {
    errors.push('expiresAt must be a valid ISO date');
  } else if (expiresAt.getTime() <= Date.now()) {
    errors.push('expiresAt must be in the future');
  }

  return {
    errors,
    normalized: {
      fileId: body.fileId,
      title: body.title ? String(body.title).trim() : '',
      message: body.message ? String(body.message).trim() : '',
      expiresAt,
      signers: signers.map((s) => ({
        name: String(s.name || '').trim(),
        email: normalizeEmail(s.email),
        order: Number(s.order)
      })),
      fields: fields.map((f) => ({
        signerEmail: normalizeEmail(f.signerEmail),
        page: Number(f.page),
        xRel: Number(f.xRel),
        yRel: Number(f.yRel),
        widthRel: Number(f.widthRel),
        heightRel: f.heightRel == null ? undefined : Number(f.heightRel),
        required: f.required !== false
      }))
    }
  };
}

router.post('/', auth, async (req, res, next) => {
  try {
    const { errors, normalized } = validateCreateBody(req.body || {});
    if (errors.length) return res.status(422).json({ message: 'Validation failed', errors });

    const fileDoc = await File.findById(normalized.fileId);
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });
    if (fileDoc.uploader.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    const existing = await SigningRequest.findOne({
      fileId: normalized.fileId,
      status: { $in: ['draft', 'in_progress'] }
    }).lean();
    if (existing) return res.status(409).json({ message: 'File already has an active signing request' });

    const signersSorted = normalized.signers.sort((a, b) => a.order - b.order);
    const signingRequest = new SigningRequest({
      fileId: normalized.fileId,
      ownerUserId: req.user.id,
      title: normalized.title,
      message: normalized.message,
      status: 'draft',
      expiresAt: normalized.expiresAt,
      signingMode: 'sequential',
      currentOrder: signersSorted[0].order,
      signers: signersSorted.map((s) => ({
        name: s.name,
        email: s.email,
        order: s.order,
        status: 'pending'
      })),
      fields: []
    });

    const signerIdByEmail = new Map(
      signingRequest.signers.map((signer) => [signer.email, signer._id])
    );

    signingRequest.fields = normalized.fields.map((field) => ({
      signerId: signerIdByEmail.get(field.signerEmail),
      type: 'signature',
      page: field.page,
      xRel: field.xRel,
      yRel: field.yRel,
      widthRel: field.widthRel,
      heightRel: field.heightRel,
      required: field.required
    }));

    await signingRequest.save();

    fileDoc.activeSigningRequestId = signingRequest._id;
    fileDoc.signingStatus = 'none';
    await fileDoc.save();

    if (req.logAudit) {
      await req.logAudit({
        fileId: fileDoc._id,
        signingRequestId: signingRequest._id,
        actorType: 'owner',
        actorUserId: req.user.id,
        action: 'SIGN_REQUEST_CREATED',
        metadata: {
          signerCount: signingRequest.signers.length,
          fieldCount: signingRequest.fields.length
        }
      });
    }

    return res.status(201).json({
      id: signingRequest._id,
      status: signingRequest.status,
      nextAction: 'send_invites'
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:requestId/send-invites', auth, async (req, res, next) => {
  try {
    const requestId = req.params.requestId;
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(422).json({ message: 'Invalid requestId' });
    }

    const signingRequest = await SigningRequest.findById(requestId);
    if (!signingRequest) return res.status(404).json({ message: 'Signing request not found' });
    if (signingRequest.ownerUserId.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
    if (['completed', 'cancelled', 'expired'].includes(signingRequest.status)) {
      return res.status(409).json({ message: `Cannot send invites for ${signingRequest.status} request` });
    }

    if (new Date(signingRequest.expiresAt).getTime() < Date.now()) {
      signingRequest.status = 'expired';
      await signingRequest.save();
      await File.findByIdAndUpdate(signingRequest.fileId, { $set: { signingStatus: 'expired' } });
      return res.status(410).json({ message: 'Signing request expired' });
    }

    const fileDoc = await File.findById(signingRequest.fileId);
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });

    const pendingSigners = signingRequest.signers
      .filter((signer) => signer.status === 'pending')
      .sort((a, b) => a.order - b.order);
    if (!pendingSigners.length) {
      return res.status(409).json({ message: 'No pending signers to invite' });
    }

    const deliveries = [];
    for (const signer of pendingSigners) {
      const inviteToken = generateOpaqueToken();
      const sharedTokenHash = hashToken(inviteToken);

      signer.inviteTokenHash = sharedTokenHash;
      signer.inviteTokenExpiresAt = signingRequest.expiresAt;
      signer.inviteTokenConsumedAt = undefined;
      signer.auditTokenHash = sharedTokenHash;
      signer.auditTokenExpiresAt = new Date(
        new Date(signingRequest.expiresAt).getTime() + (parseInt(process.env.AUDIT_TOKEN_EXPIRES_DAYS || '30', 10) * 24 * 60 * 60 * 1000)
      );

      const signingLink = `${SIGNING_LINK_BASE_URL}/sign/${inviteToken}`;
      const subject = `Signature request: ${signingRequest.title || fileDoc.originalName}`;
      const text = [
        `Hello ${signer.name},`,
        '',
        `${req.body?.senderName || 'SealVault'} invited you to sign a document.`,
        signingRequest.message ? `Message: ${signingRequest.message}` : '',
        `Signing link: ${signingLink}`,
        'Keep this same link safely. It can be used as your audit-access token after signing is complete.',
        `This link expires on ${new Date(signingRequest.expiresAt).toISOString()}.`
      ].filter(Boolean).join('\n');

      try {
        const sendResult = await sendMail({
          to: signer.email,
          subject,
          text
        });
        deliveries.push({
          email: signer.email,
          ok: true,
          mode: sendResult.mode,
          messageId: sendResult.messageId,
          mockSigningLink: sendResult.mode === 'mock' ? signingLink : undefined
        });

        if (req.logAudit) {
          await req.logAudit({
            fileId: signingRequest.fileId,
            signingRequestId: signingRequest._id,
            actorType: 'owner',
            actorUserId: req.user.id,
            action: 'INVITE_SENT',
            metadata: {
              signerId: signer._id,
              email: signer.email,
              transport: sendResult.mode
            }
          });
        }
      } catch (mailErr) {
        deliveries.push({
          email: signer.email,
          ok: false,
          error: mailErr.message || 'Email send failed'
        });

        if (req.logAudit) {
          await req.logAudit({
            fileId: signingRequest.fileId,
            signingRequestId: signingRequest._id,
            actorType: 'system',
            action: 'INVITE_SEND_FAILED',
            metadata: {
              signerId: signer._id,
              email: signer.email,
              error: mailErr.message || 'Email send failed'
            }
          });
        }
      }
    }

    signingRequest.status = 'in_progress';
    const pendingOrders = signingRequest.signers
      .filter((s) => s.status === 'pending')
      .map((s) => s.order)
      .sort((a, b) => a - b);
    signingRequest.currentOrder = pendingOrders[0] || signingRequest.currentOrder;
    await signingRequest.save();

    await File.findByIdAndUpdate(signingRequest.fileId, {
      $set: {
        activeSigningRequestId: signingRequest._id,
        signingStatus: 'in_progress'
      }
    });

    const sent = deliveries.filter((d) => d.ok).length;
    const failed = deliveries.length - sent;
    return res.json({
      id: signingRequest._id,
      status: signingRequest.status,
      summary: { total: deliveries.length, sent, failed },
      deliveries
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:requestId', auth, async (req, res, next) => {
  try {
    const requestId = req.params.requestId;
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(422).json({ message: 'Invalid requestId' });
    }

    const signingRequest = await SigningRequest.findById(requestId).lean();
    if (!signingRequest) return res.status(404).json({ message: 'Signing request not found' });
    if (signingRequest.ownerUserId.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    return res.json({
      id: signingRequest._id,
      fileId: signingRequest.fileId,
      title: signingRequest.title,
      message: signingRequest.message,
      status: signingRequest.status,
      expiresAt: signingRequest.expiresAt,
      signingMode: signingRequest.signingMode,
      currentOrder: signingRequest.currentOrder,
      completedAt: signingRequest.completedAt,
      finalPdfUrl: signingRequest.finalPdfUrl,
      signers: signingRequest.signers.map((signer) => ({
        id: signer._id,
        name: signer.name,
        email: signer.email,
        order: signer.order,
        status: signer.status,
        signedAt: signer.signedAt
      })),
      fields: signingRequest.fields.map((field) => ({
        id: field._id,
        signerId: field.signerId,
        type: field.type,
        page: field.page,
        xRel: field.xRel,
        yRel: field.yRel,
        widthRel: field.widthRel,
        heightRel: field.heightRel,
        required: field.required,
        signedAt: field.signedAt
      })),
      createdAt: signingRequest.createdAt,
      updatedAt: signingRequest.updatedAt
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
