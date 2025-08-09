// index.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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
app.options(/.*/, cors(corsOptions)); // Preflight for any path (Express 5 compatible)
app.use(cors(corsOptions));

/* ============================
   Multer (in-memory)
   ============================ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // ~15MB
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

// Prevent traversal and unexpected prefixes when reading back
const ALLOWED_PREFIXES = ['full/', 'thumbnails/'];
function isAllowedKey(key = '') {
  if (typeof key !== 'string') return false;
  if (key.includes('..')) return false;
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

/* ============================
   Health & Root
   ============================ */
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.send('R2 image compressor is running.'));

/* ============================
   Upload + Compress
   Field name: "file"
   ============================ */
app.post('/', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'];
    if (file.mimetype && !allowed.includes(file.mimetype)) {
      return res.status(400).json({ success: false, error: `Unsupported content type: ${file.mimetype}` });
    }

    const base = sanitizeBaseName(file.originalname);
    const stamp = Date.now();
    const fileName = `${stamp}-${base}.webp`;

    // Full-size (max width 1080)
    const fullImageBuffer = await sharp(file.buffer)
      .rotate() // auto-orient via EXIF
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

/* ============================
   Signed URL (Private fetch)
   GET /signed-url?key=<r2-key>&expires=3600
   ============================ */
app.get('/signed-url', async (req, res) => {
  try {
    const { key, expires } = req.query;
    if (!key) return res.status(400).json({ success: false, error: 'Missing key' });
    if (!isAllowedKey(key)) return res.status(400).json({ success: false, error: 'Invalid key' });

    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: Number(expires) || 3600 });
    return res.json({ success: true, url });
  } catch (err) {
    console.error('signed-url error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

/* ============================
   (Optional) Streaming proxy
   GET /image?key=<r2-key>
   Good if you want your own cache headers & domain.
   ============================ */
app.get('/image', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).send('Missing key');
    if (!isAllowedKey(key)) return res.status(400).send('Invalid key');

    const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key });
    const data = await s3.send(command); // data.Body is a stream

    // Set basic cache headers (tune to your needs)
    res.setHeader('Content-Type', data.ContentType || 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300'); // 5 minutes
    if (data.ETag) res.setHeader('ETag', data.ETag);

    data.Body.pipe(res);
  } catch (err) {
    console.error('image proxy error:', err);
    res.status(500).send('Server error');
  }
});

/* ============================ */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
