// helpers/storage.js
const fs = require('fs');
const path = require('path');

let supabase;
try { supabase = require('../config/supabase'); } catch (e) { supabase = null; }

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

async function saveBuffer(buffer, key, mimetype) {
  // key should be something like `${userId}/${timestamp}-${originalName}`
  if (supabase) {
    try {
      const { data, error } = await supabase.storage.from(process.env.SUPABASE_BUCKET).upload(key, buffer, { contentType: mimetype, upsert: false });
      if (error) throw error;
      // try obtaining signed url (short expiry) or public url
      let url = null;
      try {
        const { data: signed, error: signErr } = await supabase.storage.from(process.env.SUPABASE_BUCKET).createSignedUrl(key, 60 * 60);
        if (!signErr && signed?.signedUrl) url = signed.signedUrl;
      } catch (e) {
        // ignore
      }
      return { storagePath: key, url: url || null, provider: 'supabase' };
    } catch (err) {
      console.warn('Supabase save failed, fallback to local:', err?.message || err);
      // fall through to local
    }
  }

  // local fallback
  const safeKey = key.replace(/[^\w.-]/g, '_');
  const localPath = path.join(UPLOAD_DIR, safeKey);
  fs.writeFileSync(localPath, buffer);
  const publicUrl = `/uploads/${safeKey}`;
  return { storagePath: `local/${safeKey}`, url: publicUrl, provider: 'local' };
}

module.exports = { saveBuffer };

// // helpers/storage.js
// const fs = require('fs');
// const path = require('path');
// const os = require('os');

// let appwrite = null;
// try { appwrite = require('../config/appwrite'); } catch (e) { appwrite = null; }

// const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
// if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// /**
//  * Save a buffer to storage. Tries Appwrite (if configured) then falls back to local disk.
//  * Returns { storagePath, url, provider } where:
//  *  - storagePath is a logical path used by your app (prefix by provider for clarity)
//  *  - url is a public/view URL or local public path /uploads/...
//  *  - provider is 'appwrite' or 'local'
//  */
// async function saveBuffer(buffer, key, mimetype) {
//   // sanitize key for filesystem usage where needed
//   const safeKey = String(key).replace(/[^\w.-]/g, '_');

//   // 1) Try Appwrite
//   if (appwrite && appwrite.storage) {
//     try {
//       const bucketId = process.env.APPWRITE_BUCKET_ID;
//       if (!bucketId) throw new Error('APPWRITE_BUCKET_ID not set');

//       // write temp file
//       const tmpDir = path.join(os.tmpdir(), 'sealvault-upload-tmp');
//       if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
//       const tmpName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(safeKey)}`;
//       const tmpPath = path.join(tmpDir, tmpName);
//       fs.writeFileSync(tmpPath, buffer);

//       // choose fileId as 'unique()' to let Appwrite generate a unique id
//       // node-appwrite expects a file stream for createFile
//       const stream = fs.createReadStream(tmpPath);

//       // create file on Appwrite
//       // Important: createFile(bucketId, fileId, file) - use 'unique()' as fileId to auto assign
//       const result = await appwrite.storage.createFile(bucketId, 'unique()', stream);

//       // delete tmp
//       try { fs.unlinkSync(tmpPath); } catch (ignored) {}

//       // Build a view/download URL for the uploaded file:
//       // Appwrite's download/view endpoints need project query param:
//       // `${APPWRITE_ENDPOINT}/storage/buckets/{bucketId}/files/{fileId}/view?project={project}`
//       const fileId = result.$id || result['$id'] || result.id || result['id'];
//       const endpoint = process.env.APPWRITE_ENDPOINT.replace(/\/$/, '');
//       const project = process.env.APPWRITE_PROJECT;
//       // Use "view" to open in browser or "download" to force download
//       const publicUrl = `${endpoint}/storage/buckets/${bucketId}/files/${fileId}/view?project=${project}`;

//       return { storagePath: `appwrite/${bucketId}/${fileId}`, url: publicUrl, provider: 'appwrite' };
//     } catch (err) {
//       console.warn('Appwrite save failed, falling back to local:', err?.message ?? err);
//       // continue to local fallback
//     }
//   }

//   // 2) Local fallback (write to uploads directory)
//   const localPath = path.join(UPLOAD_DIR, safeKey);
//   fs.writeFileSync(localPath, buffer);
//   const publicUrl = `/uploads/${safeKey}`;
//   return { storagePath: `local/${safeKey}`, url: publicUrl, provider: 'local' };
// }

// module.exports = { saveBuffer };