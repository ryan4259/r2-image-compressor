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
  'https://r2-image-compressor.onrender.com', // Render backend itself
  // 'https://your-custom-domain.com'    // <— add later if needed
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

app.options('*', cors(corsOptions)); // Preflight
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

    // Clean filename
    const originalName = path.parse(file.originalname).name.replace(/\s+/g, '_');
    const fileName = `${Date.now()}-${originalName}.webp`;

    // Full-size image
    const fullImageBuffer = await sharp(file.buffer)
      .resize({ width: 1080, withoutEnlargement: true })
      .toFormat('webp', { quality: 75 })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `full/${fileName}`,
      Body: fullImageBuffer,
      ContentType: 'image/webp',
    }));

    // Thumbnail
    const thumbBuffer = await sharp(file.buffer)
      .resize({ width: 300 })
      .toFormat('webp', { quality: 70 })
      .toBuffer();

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `thumbnails/${fileName}`,
      Body: thumbBuffer,
      ContentType: 'image/webp',
    }));

    // Return ONLY the keys (not public URLs)
    res.json({
      success: true,
      fullKey: `full/${fileName}`,
      thumbKey: `thumbnails/${fileName}`,
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
