const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const uploadToR2 = async (buffer, key) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: 'image/webp',
    })
  );
};

app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const inputPath = req.file.path;
    const fileName = path.parse(req.file.originalname).name;

    // Compress to full-size WebP
    const fullImageBuffer = await sharp(inputPath)
      .resize({ width: 1080, withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();

    await uploadToR2(fullImageBuffer, `full/${fileName}.webp`);

    // Create thumbnail WebP
    const thumbImageBuffer = await sharp(inputPath)
      .resize({ width: 300 })
      .webp({ quality: 60 })
      .toBuffer();

    await uploadToR2(thumbImageBuffer, `thumb/${fileName}.webp`);

    fs.unlinkSync(inputPath); // cleanup

    res.json({
      full_url: `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ENDPOINT.replace(/^https?:\/\//, '')}/full/${fileName}.webp`,
      thumb_url: `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ENDPOINT.replace(/^https?:\/\//, '')}/thumb/${fileName}.webp`,
    });
  } catch (err) {
    console.error('❌ Error during upload:', err);
    res.status(500).json({ error: 'Image processing failed' });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
