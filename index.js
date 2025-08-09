const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

/* ============================
   ✅ Manual CORS (with preflight)
   ============================ */
const allowedOrigins = new Set([
  'http://localhost:3000',              // Local dev
  'https://app.flutterflow.io',         // FlutterFlow Test Mode
  // 'https://your-custom-domain.com',  // <— add later
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Allow no-origin (Postman/mobile) OR origin in allowlist
  const isAllowed = !origin || allowedOrigins.has(origin) || process.env.NODE_ENV === 'development';

  if (isAllowed) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    else res.setHeader('Access-Control-Allow-Origin', '*');

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    // res.setHeader('Access-Control-Allow-Credentials', 'true'); // enable if you need cookies

    if (req.method === 'OPTIONS') return res.sendStatus(200);
    return next();
  }

  if (req.method === 'OPTIONS') return res.sendStatus(403);
  return res.status(403).json({ success: false, error: `Not allowed by CORS: ${origin || 'no-origin'}` });
});

/* ============================
   ✅ Multer Setup
   ============================ */
const upload = multer();

/* ============================
   ✅ S3 Client (Cloudflare R2)
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

    // Public base URL
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

/* ============================
   ✅ Start Server
   ============================ */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
