const express = require('express');
const mongoose = require('mongoose');

const optionalAuth = require('../middleware/optionalAuth');
const auditAccessGuard = require('../middleware/auditAccessGuard');
const AuditEvent = require('../models/AuditEvent');
const SigningRequest = require('../models/SigningRequest');

const router = express.Router();

router.get('/:fileId', optionalAuth, (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.fileId)) {
    return res.status(422).json({ message: 'Invalid fileId' });
  }
  return next();
}, auditAccessGuard, async (req, res, next) => {
  try {
    const fileId = req.params.fileId;

    let signingRequest = req.auditSigningRequest;
    if (!signingRequest) {
      signingRequest = await SigningRequest.findOne({ fileId }).sort({ createdAt: -1 }).lean();
    }

    const events = await AuditEvent.find({
      fileId,
      ...(signingRequest?._id ? { signingRequestId: signingRequest._id } : {})
    })
      .sort({ createdAt: 1 })
      .lean();

    return res.json({
      fileId,
      viewer: req.auditViewer,
      signingRequest: signingRequest
        ? {
            id: signingRequest._id,
            status: signingRequest.status,
            completedAt: signingRequest.completedAt,
            currentOrder: signingRequest.currentOrder
          }
        : null,
      events: events.map((event) => ({
        id: event._id,
        action: event.action,
        actorType: event.actorType,
        actorEmail: event.actorEmail,
        actorUserId: event.actorUserId,
        actorSignerId: event.actorSignerId,
        ip: event.ip,
        userAgent: event.userAgent,
        metadata: event.metadata,
        createdAt: event.createdAt
      }))
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
