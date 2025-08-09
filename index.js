const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

/* ============================
   ✅ CORS (manual, with preflight)
   - Allows any FlutterFlow host (app/flutterflow.app + *.flutterflow.app + *.flutterflow.io)
   - Allows localhost
   - Allows extra origins via env: ALLOWED_ORIGINS="https://yourdomain.com, yourdomain.com"
   ============================ */
function isAllowedOrigin(origin) {
  if (!origin) return true; // Postman/mobile
  try {
    const url = new URL(origin);
    const h = url.hostname.toLowerCase();

    const isFlutterFlow =
      h === 'app.flutterflow.io' ||
      h === 'preview.flutterflow.app' ||
      h.endsWith('.flutterflow.app') ||
      h.endsWith('.flutterflow.io');

    const isLocalhost = h === 'localhost' || h === '127.0.0.1';

    const extra = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const inExtra = extra.includes(origin) || extra.includes(h);

    return isFlutterFlow || isLocalhost || inExtra;
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = isAllowedOrigin(origin) || process.env.NODE_ENV === 'development';

  if (process.env.LOG_ORIGIN === '1') {
    console.log('[CORS] Origin:', origin || '(no-origin)', '=>', allowed ? 'ALLOW' : 'BLOCK');
  }

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
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

/* ============================ */
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
  fo
