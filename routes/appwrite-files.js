// routes/appwrite-files.js
const express = require('express');
const appwrite = require('../config/appwrite');
const router = express.Router();
const auth = require('../middleware/auth');

if (!appwrite) {
  console.warn('Appwrite client not configured — /api/appwrite/files routes disabled');
  module.exports = router;
  return;
}

const BUCKET = process.env.APPWRITE_BUCKET_ID;

// GET /api/appwrite/files/:fileId/download
// This proxies Appwrite file download (server-side auth), returns file bytes.
// You may want to protect this with auth; below example requires auth.
router.get('/files/:fileId/download', auth, async (req, res) => {
  try {
    const fileId = req.params.fileId;
    // Appwrite Storage SDK provides getFileDownload which returns a stream/Buffer via HTTP layer.
    const download = await appwrite.storage.getFileDownload(BUCKET, fileId);
    // The SDK returns binary data in response; the node SDK may give a buffer in .toString? Check runtime if adjustments needed.
    // Safe approach: fetch via the REST endpoint with server key and pipe response.
    // We'll do a simple HTTP fetch to the Appwrite endpoint using project and key to stream bytes:
    const endpoint = process.env.APPWRITE_ENDPOINT.replace(/\/$/, '');
    const project = process.env.APPWRITE_PROJECT;
    const url = `${endpoint}/storage/buckets/${BUCKET}/files/${fileId}/download?project=${project}`;

    const fetch = global.fetch || require('node-fetch');
    const r = await fetch(url, {
      headers: {
        'X-Appwrite-Project': project,
        'X-Appwrite-Key': process.env.APPWRITE_KEY
      }
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(502).send(`Appwrite fetch failed: ${r.status} ${txt}`);
    }
    // Set content-type if available (pass-through)
    if (r.headers.get('content-type')) res.setHeader('Content-Type', r.headers.get('content-type'));
    r.body.pipe(res);
  } catch (err) {
    console.error('Appwrite file proxy error', err);
    res.status(500).json({ message: 'Could not fetch file' });
  }
});

module.exports = router;