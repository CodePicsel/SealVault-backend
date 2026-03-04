const path = require('path');
const { PDFDocument } = require('pdf-lib');

const { saveBuffer } = require('../helpers/storage');
const { loadAssetBytes } = require('./fileAccess');

async function composeFinalSignedPdf({ fileDoc, signingRequest }) {
  const sourceBytes = await loadAssetBytes({
    storagePath: fileDoc.storagePath,
    url: fileDoc.url
  });
  const pdfDoc = await PDFDocument.load(sourceBytes);

  const signerImageCache = new Map();

  for (const signer of signingRequest.signers) {
    if (
      signer.status !== 'signed' ||
      (!signer.signatureAsset?.storagePath && !signer.signatureAsset?.url)
    ) continue;
    const signerKey = signer._id.toString();
    if (signerImageCache.has(signerKey)) continue;

    const imageBytes = await loadAssetBytes({
      storagePath: signer.signatureAsset.storagePath,
      url: signer.signatureAsset.url
    });

    const mimeType = (signer.signatureAsset.mimeType || '').toLowerCase();
    const embedded = mimeType.includes('png')
      ? await pdfDoc.embedPng(imageBytes)
      : await pdfDoc.embedJpg(imageBytes);

    signerImageCache.set(signerKey, {
      embedded,
      width: embedded.width,
      height: embedded.height
    });
  }

  for (const field of signingRequest.fields) {
    const signerKey = field.signerId.toString();
    const cached = signerImageCache.get(signerKey);
    if (!cached) continue;

    const pageIndex = Math.max(0, Number(field.page) - 1);
    if (pageIndex >= pdfDoc.getPageCount()) continue;

    const page = pdfDoc.getPage(pageIndex);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const drawWidth = Number(field.widthRel) * pageWidth;
    const drawHeight = field.heightRel
      ? Number(field.heightRel) * pageHeight
      : drawWidth * (cached.height / cached.width);

    const x = Number(field.xRel) * pageWidth;
    const yFromTop = Number(field.yRel) * pageHeight;
    const y = pageHeight - yFromTop - drawHeight;

    page.drawImage(cached.embedded, {
      x,
      y,
      width: drawWidth,
      height: drawHeight
    });
  }

  const finalBytes = await pdfDoc.save();
  const safeOriginalName = path.basename(fileDoc.originalName || `file-${fileDoc._id}.pdf`).replace(/\s+/g, '_');
  const key = `signed/${fileDoc.uploader}/${Date.now()}-workflow-${safeOriginalName}`;
  const stored = await saveBuffer(Buffer.from(finalBytes), key, 'application/pdf');

  return {
    storagePath: stored.storagePath,
    url: stored.url
  };
}

module.exports = {
  composeFinalSignedPdf
};
