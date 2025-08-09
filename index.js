const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

/* ============================
   ✅ Manual CORS (with preflight) — allows FlutterFlow + localhost + env list
   ============================ */
function isAllowedOrigin(origin) {
  if (!origin) return true; // Postman/mobile
  try {
    const url = new URL(origin);
    const h = url.hostname.toLowerCase();

    // Allow FlutterFlow editors/previews/hosting
    const isFlutterFlow =
      h === 'app.flutterflow.io' ||
      h.endsWith('.flutterflow.app') ||
      h.endsWith('.flutterflow.io');

    // Allow localhost (any port)
    const isLocalhost = h === 'localhost' || h === '127.0.0.1';

    // Allow extra origins from env (comma-separated). You can put full origins or hostnames.
    const extra = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const inExtra =
      extra.includes(origin) || // exact origin match, e.g. https://yourdomain.com
      extra.includes(h);        // or hostname only, e.g. yourdomain.com

    return isFlutterFlow || isLocalhost || inExtra;
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = isAllowedOrigin(origin) || process.env.NODE_ENV === 'development';

  // Log the origin we saw (helps debug)
  if (process.env.LOG_ORIGIN === '1') {
    console.log('[CORS] Origin:', origin || '(no-origin)');
  }

  if (allowed) {
    // Echo the specific origin if present, else *
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    // res.setHeader('Access-Control-Allow-Credentials', 'true'); // enable if you use cookies

    if (req.method === 'OPTIONS') return res.sendStatus(200);
    return next();
  }

  if (req.method === 'OPTIONS') return res.sendStatus(403);
  return res.status(403).json({ success: false, error: `Not allowed by CORS: ${origin || 'no-origin'}` });
});

/* ============================
   ✅ Multer
   ============================ */
const upload = multer();

/* ============================
   ✅ Cloudflare R2 (S3-compatible)
   ============================ */
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

/* ============================
   ✅ Upload Route
   ============================ */
app.post('/', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // Clean filename: strip extension & spaces, single timestamp
    const originalName = path.parse(file.originalname).name.replace(/\s+/g, '_');
    const fileName = `${Date.now()}-${originalName}`;

    // Full-size (webp)
    const fullImageBuffer = await sharp(file.buffer)
      .resize({ width: 1080, withoutEnlargement: true })
      .toFormat('webp', { quality: 75 })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `full/${fileName}.webp`,
      Body: fullImageBuffer,
      ContentType: 'image/webp',
    }));

    // Thumbnail (webp)
    const thumbBuffer = await sharp(file.buffer)
      .resize({ width: 300 })
      .toFormat('webp', { quality: 70 })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `thumbnails/${fileName}.webp`,
      Body: thumbBuffer,
      ContentType: 'image/webp',
    }));

    const baseUrl = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}`;

    res.json({
      success: true,
      fullSizeUrl: `${baseUrl}/full/${fileName}.webp`,
      thumbnailUrl: `${baseUrl}/thumbnails/${fileName}.webp`,
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================ */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
