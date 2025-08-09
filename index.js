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
   ✅ CORS Setup (with preflight)
   ============================ */
const allowedOrigins = [
  'http://localhost:3000',              // Local dev
  'https://app.flutterflow.io',         // FlutterFlow Test Mode
  'https://r2-image-compressor.onrender.com', // (Not required, but harmless)
  // 'https://your-custom-domain.com'    // <— add later
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
  optionsSuccessStatus: 200, // some old browsers choke on 204
};

// Preflight handler
app.options('*', cors(corsOptions));
// Main CORS
app.use(cors(corsOptions));

/* ============================ */
const upload = multer();

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
