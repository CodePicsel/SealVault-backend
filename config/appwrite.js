// config/appwrite.js
const fs = require('fs');
let AppwriteClient;
try {
  AppwriteClient = require('node-appwrite'); // node-appwrite SDK
} catch (e) {
  console.warn('node-appwrite not installed; Appwrite disabled.');
  module.exports = null;
  return;
}

const endpoint = process.env.APPWRITE_ENDPOINT;
const project = process.env.APPWRITE_PROJECT;
const key = process.env.APPWRITE_KEY;

if (!endpoint || !project || !key) {
  console.warn('Appwrite env not present or incomplete — Appwrite storage disabled.');
  module.exports = null;
  return;
}

const client = new AppwriteClient.Client()
  .setEndpoint(endpoint.replace(/\/$/, '')) // remove trailing slash
  .setProject(project)
  .setKey(key);

const storage = new AppwriteClient.Storage(client);

module.exports = { client, storage };