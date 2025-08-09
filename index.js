// index.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

/* ============================
   CORS (Express 5-safe)
   ============================ */
const allowedOrigins = [
  'http://localhost:3000',                   // Local dev
  'https://app.flutterflow.io',              // FlutterFlow Test Mode
  'https://r2-image-compressor.onrender.com' // This Render service
  // 'https://your-custom-domain.com',        // Add when ready
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200,
};

// ✅ Express 5 compatible wildcard:
app.options(/.*/, cors(corsOptions)); // Preflight for any path
app.use(cors(corsOptions));

/* ============================
   Multer (in-memory)
   ============================ */
const upload = multer({
  storage: multer.memoryStorage(),
  // Optional: limit size to ~15MB
  limits: { fileSize: 15 * 1024 * 1024 }
});

/* ============================
   Cloudflare R2 (AWS SDK v3)
   ============================ */
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT, // e.g. https://<accountid>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

/* ============================
   Helpers
   ============================ */
function sanitizeBaseName(original) {
  const base = path.parse(original).name || 'image';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/* ============================
   Routes
   ============================ */

// Health/diagnostic
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Optional root
app.get('/', (_req, res) => {
  res.send('R2 image compressor is running.');
});

/* ============================
   Upload + Compress
   Field name: "file"
   ============================ */
app.post('/', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // Basic mime/type check (allow common image types)
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'];
    if (file.mimetype && !allowed.includes(file.mimetype)) {
      return res.status(400).json({ success: false, error: `Unsupported content type: ${file.mimetype}` });
    }

    const base = sanitizeBaseName(file.originalname);
    const stamp = Date.now();
    const fileName = `${stamp}-${base}.webp`;

    // Full-size (max width 1080)
    const fullImageBuffer = await sharp(file.buffer)
      .rotate() // auto-orient using EXIF
      .resize({ width: 1080, withoutEnlargement: true })
      .toFormat('webp', { quality: 75 })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `full/${fileName}`,
      Body: fullImageBuffer,
      ContentType: 'image/webp',
    }));

    // Thumbnail (width 300)
    const thumbBuffer = await sharp(file.buffer)
      .rotate()
      .resize({ width: 300 })
      .toFormat('webp', { quality: 70 })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `thumbnails/${fileName}`,
      Body: thumbBuffer,
      ContentType: 'image/webp',
    }));

    // Return keys only (private by default).
    return res.json({
      success: true,
      fullKey: `full/${fileName}`,
      thumbKey: `thumbnails/${fileName}`,
    });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

/* ============================ */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
