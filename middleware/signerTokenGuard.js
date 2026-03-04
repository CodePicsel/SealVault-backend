const SigningRequest = require('../models/SigningRequest');
const { hashToken } = require('../services/tokenService');

function hasExpired(dateValue) {
  if (!dateValue) return false;
  return new Date(dateValue).getTime() < Date.now();
}

module.exports = (options = {}) => {
  const {
    requireInProgress = false,
    requireCurrentOrder = false,
    requireUnconsumed = false
  } = options;

  return async (req, res, next) => {
    try {
      const inviteToken = req.params.inviteToken;
      if (!inviteToken) return res.status(401).json({ message: 'Invite token is required' });

      const inviteTokenHash = hashToken(inviteToken);
      const signingRequest = await SigningRequest.findOne({
        'signers.inviteTokenHash': inviteTokenHash
      });
      if (!signingRequest) return res.status(404).json({ message: 'Invalid signing link' });

      const signer = signingRequest.signers.find((s) => s.inviteTokenHash === inviteTokenHash);
      if (!signer) return res.status(404).json({ message: 'Signer not found' });

      const expired = hasExpired(signer.inviteTokenExpiresAt) || hasExpired(signingRequest.expiresAt);
      if (expired) {
        if (signer.status === 'pending') signer.status = 'expired';
        await signingRequest.save();
        return res.status(410).json({ message: 'Signing link expired' });
      }

      if (requireInProgress && signingRequest.status !== 'in_progress') {
        return res.status(409).json({ message: `Signing request is ${signingRequest.status}` });
      }

      if (requireUnconsumed && signer.inviteTokenConsumedAt) {
        return res.status(410).json({ message: 'Signing link has already been used' });
      }

      if (requireCurrentOrder && signer.order !== signingRequest.currentOrder) {
        return res.status(409).json({ message: 'Signing is locked until previous signer completes' });
      }

      req.signingRequest = signingRequest;
      req.signer = signer;
      req.inviteTokenHash = inviteTokenHash;
      return next();
    } catch (err) {
      return next(err);
    }
  };
};
