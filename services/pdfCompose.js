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

    const boxWidth = Number(field.widthRel) * pageWidth;
    const boxHeight = field.heightRel
      ? Number(field.heightRel) * pageHeight
      : boxWidth * (cached.height / cached.width);

    const boxX = Number(field.xRel) * pageWidth;
    const boxYFromTop = Number(field.yRel) * pageHeight;

    const boxRatio = boxHeight / boxWidth;
    const imgRatio = cached.height / cached.width;

    let finalW = boxWidth;
    let finalH = boxHeight;

    if (imgRatio > boxRatio) {
      // image is taller than the box, clamp height
      finalH = boxHeight;
      finalW = boxHeight / imgRatio;
    } else {
      // image is wider than the box, clamp width
      finalW = boxWidth;
      finalH = boxWidth * imgRatio;
    }

    const offsetX = (boxWidth - finalW) / 2;
    const offsetY = (boxHeight - finalH) / 2;

    const x = boxX + offsetX;
    const yFromTop = boxYFromTop + offsetY;
    const y = pageHeight - yFromTop - finalH;

    page.drawImage(cached.embedded, {
      x,
      y,
      width: finalW,
      height: finalH
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
