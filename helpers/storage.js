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