const fs = require('fs');
const path = require('path');

let supabase = null;
try {
  supabase = require('../config/supabase');
} catch (err) {
  supabase = null;
}

const BUCKET = process.env.SUPABASE_BUCKET || 'user-files';

function getLocalFilename({ storagePath, url }) {
  if (storagePath && storagePath.startsWith('local/')) {
    return path.basename(storagePath.replace(/^local\//, ''));
  }
  if (url && url.startsWith('/uploads/')) {
    return path.basename(url.replace(/^\/uploads\//, ''));
  }
  return null;
}

async function createSupabaseSignedUrl(storagePath, expiresInSeconds = 300) {
  if (!supabase || !storagePath || storagePath.startsWith('local/')) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, expiresInSeconds);
  if (error) return null;
  return data?.signedUrl || null;
}

async function resolveAssetUrl(asset, expiresInSeconds = 300) {
  const localFilename = getLocalFilename(asset || {});
  if (localFilename) return `/uploads/${localFilename}`;

  if (asset?.storagePath) {
    const signed = await createSupabaseSignedUrl(asset.storagePath, expiresInSeconds);
    if (signed) return signed;
  }
  return asset?.url || null;
}

async function loadAssetBytes(asset) {
  const localFilename = getLocalFilename(asset || {});
  if (localFilename) {
    const fullPath = path.join(process.cwd(), 'uploads', localFilename);
    if (!fs.existsSync(fullPath)) throw new Error('Local file missing');
    return fs.readFileSync(fullPath);
  }

  let remoteUrl = null;
  if (asset?.storagePath) {
    remoteUrl = await createSupabaseSignedUrl(asset.storagePath, 300);
  }
  if (!remoteUrl && asset?.url) remoteUrl = asset.url;
  if (!remoteUrl) throw new Error('No method to load file bytes');

  const response = await fetchWithFallback(remoteUrl);
  if (!response.ok) throw new Error(`File fetch failed with status ${response.status}`);
  const arr = await response.arrayBuffer();
  return Buffer.from(arr);
}

async function fetchWithFallback(url, options) {
  if (global.fetch) return global.fetch(url, options);
  const nodeFetch = await import('node-fetch');
  return nodeFetch.default(url, options);
}

module.exports = {
  resolveAssetUrl,
  loadAssetBytes
};
