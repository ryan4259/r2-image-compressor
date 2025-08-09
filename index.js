const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// ✅ Hybrid CORS: allow FlutterFlow preview, localhost, and easy custom domain add later
const allowedOrigins = [
  'https://preview.flutterflow.app', // FlutterFlow preview
  'http://localhost:3000',           // Local dev
  // 'https://yourcustomdomain.com'   // <-- Add here later for production
];

app.use(cors({
  origin: function (origin, callback) {
    console.log(`CORS check: Origin = ${origin}`); // Log to Render console

    // Allow requests with no origin (Postman, mobile apps)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error(`Not allowed by CORS: ${origin}`));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

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

app.post('/', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded — make sure the form-data field name is "file"'
      });
    }

    const baseName = file.originalname.replace(/\.[^/.]+$/, ''); // remove extension
    const fileName = `${Date.now()}-${baseName}`;

    // Compress full-size image
    const fullImageBuffer = await sharp(file.buffer)
      .resize({ width: 1080, withoutEnlargement: true })
      .toFormat('webp', { quality: 75 })
      .toBuffer();

    // Upload full-size image
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `full/${fileName}.webp`,
      Body: fullImageBuffer,
      ContentType: 'image/webp',
    }));

    // Create thumbnail
    const thumbBuffer = await sharp(file.buffer)
      .resize({ width: 300 })
      .toFormat('webp', { quality: 70 })
      .toBuffer();

    // Upload thumbnail
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

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
