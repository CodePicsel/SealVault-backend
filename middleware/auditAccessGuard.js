const File = require('../models/File');
const SigningRequest = require('../models/SigningRequest');
const { hashToken } = require('../services/tokenService');

module.exports = async (req, res, next) => {
  try {
    const fileId = req.params.fileId;
    const fileDoc = await File.findById(fileId).lean();
    if (!fileDoc) return res.status(404).json({ message: 'File not found' });

    const signerAuditToken = req.headers['x-audit-token'];
    const authUserId = req.user?.id;

    if (authUserId && fileDoc.uploader?.toString() === authUserId) {
      req.auditViewer = { type: 'owner', userId: authUserId };
      req.auditFile = fileDoc;
      return next();
    }

    if (!signerAuditToken || typeof signerAuditToken !== 'string') {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const tokenHash = hashToken(signerAuditToken);
    const signingRequest = await SigningRequest.findOne({
      fileId,
      'signers.auditTokenHash': tokenHash
    });

    if (!signingRequest) return res.status(403).json({ message: 'Forbidden' });

    const signer = signingRequest.signers.find((s) => s.auditTokenHash === tokenHash);
    if (!signer) return res.status(403).json({ message: 'Forbidden' });

    const isExpired = signer.auditTokenExpiresAt && new Date(signer.auditTokenExpiresAt).getTime() < Date.now();
    if (isExpired || signer.status !== 'signed') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    req.auditViewer = {
      type: 'signer',
      signerId: signer._id.toString(),
      email: signer.email
    };
    req.auditFile = fileDoc;
    req.auditSigningRequest = signingRequest;
    return next();
  } catch (err) {
    return next(err);
  }
};
