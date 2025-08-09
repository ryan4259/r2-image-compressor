// index.js
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// ─────────────────────────────────────────────
// CORS (manual + preflight): allow FlutterFlow + localhost + extra via env
// Set ALLOWED_ORIGINS="https://preview.flutterflow.app, https://app.flutterflow.io, https://yourdomain.com"
function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const h = url.hostname.toLowerCase();
    const isFF = h === 'app.flutterflow.io' || h === 'preview.flutterflow.app' || h.endsWith('.flutterflow.app') || h.endsWith('.flutterflow.io');
    const isLocal = h === 'localhost' || h === '127.0.0.1';
    const extra = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (process.env.ALLOW_ALL_ORIGINS === '1' || extra.includes('*')) return true;
    const inExtra = extra.includes(origin) || extra.includes(h);
    return isFF || isLocal || inExtra;
  } catch {
    return false;
  }
}
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = isAllowedOrigin(origin) || process.env.NODE_ENV === 'development';
  if (process.env.LOG_ORIGIN === '1') console.log('[CORS]', origin || '(no-origin)', '=>', allowed ? 'ALLOW' : 'BLOCK');
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    return next();
  }
  if (req.method === 'OPTIONS') return res.sendStatus(403);
  return res.status(403).json({ success: false, error: `Not allowed by CORS: ${origin || 'no-origin'}` });
});

// ─────────────────────────────────────────────
// Helpers
const upload = multer();
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT, // e.g. https://<account-id>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

function randomId(n = 8) {
  return crypto.randomBytes(n).toString('hex');
}

// Minimal auth placeholder: we accept X-User-Id header from your app.
// (Later you can verify a Supabase JWT here if you want strict auth.)
function getUserId(req) {
  // Prefer explicit header; fall back to none.
  return req.header('X-User-Id') || null;
}

// ─────────────────────────────────────────────
// Upload route: FlutterFlow -> Render -> R2 (private)
// Returns object keys only. No public URLs.
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Missing X-User-Id' });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded (field must be "file")' });
    }

    const baseName = path.parse(file.originalname).name.replace(/\s+/g, '_');
    const stamp = Date.now();
    const rid = randomId(6);
    const keyBase = `users/${userId}/${stamp}-${rid}-${baseName}`;

    // Full
    const fullBuf = await sharp(file.buffer)
      .resize({ width: 1080, withoutEnlargement: true })
      .toFormat('webp', { quality: 75 })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `${keyBase}.full.webp`,
      Body: fullBuf,
      ContentType: 'image/webp',
      CacheControl: 'private, max-age=0, no-cache',
      Metadata: { owner: userId, visibility: 'private' },
    }));

    // Thumb
    const thumbBuf = await sharp(file.buffer)
      .resize({ width: 300 })
      .toFormat('webp', { quality: 70 })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `${keyBase}.thumb.webp`,
      Body: thumbBuf,
      ContentType: 'image/webp',
      CacheControl: 'private, max-age=0, no-cache',
      Metadata: { owner: userId, visibility: 'private' },
    }));

    // Return KEYS only (store these in Supabase)
    return res.json({
      success: true,
      keys: {
        full: `${keyBase}.full.webp`,
        thumb: `${keyBase}.thumb.webp`,
      },
      ownerId: userId,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Download token minting: client asks Render for a short-lived token for a key.
// Your Worker will verify this token and stream the file from R2 (private).
// Body: { key: "users/<uid>/<...>.full.webp" }
// Header: X-User-Id: <uid>  (later you can enforce RBAC here)
app.use(express.json());
app.post('/download-token', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Missing X-User-Id' });
    }
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing "key"' });
    }

    // Very basic ownership guard: require key path to start with users/<userId>/
    // (Upgrade later if you have “followers-only” logic.)
    if (!key.startsWith(`users/${userId}/`)) {
      return res.status(403).json({ success: false, error: 'Forbidden for this key' });
    }

    const payload = {
      sub: userId,
      key,
      // Add any other claims you want Worker to check (e.g., scope: 'read:image')
      scope: 'read:image',
    };

    const token = jwt.sign(payload, process.env.DOWNLOAD_JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '5m', // short-lived token
      issuer: 'render-backend',
      audience: 'cf-worker',
    });

    // The client will call your Worker URL like:
    // GET https://<your-worker-domain>/i?token=<token>
    return res.json({ success: true, token, expiresInSeconds: 300 });
  } catch (err) {
    console.error('Token error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
