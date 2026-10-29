'use strict';

require('dns').setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const settings = require('../config/settings');
const DB = require('./db');
const { streamProxy } = require('./proxy');

const app = express();

app.disable('x-powered-by');
// Di belakang Cloudflare Tunnel (cloudflared berjalan di container yang sama).
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err && err.message ? err.message : err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err && err.stack ? err.stack : err));

// ── Origin yang diizinkan memanggil API (frontend Vercel) ──
function isOriginAllowed(origin) {
  if (!origin) return false;
  if (settings.ALLOWED_ORIGINS.includes(origin)) return true;
  if (settings.ALLOW_VERCEL_APP) {
    try {
      const u = new URL(origin);
      if (u.protocol === 'https:' && u.hostname.endsWith('.vercel.app')) return true;
    } catch (_) { /* abaikan */ }
  }
  return false;
}

// Request dari browser yang membawa Origin asing ditolak. Request tanpa Origin
// (<audio>, curl, aplikasi native) tetap dilayani seperti biasa.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || isOriginAllowed(origin)) return next();
  return res.status(403).json({ success: false, message: 'Akses ditolak: origin tidak diizinkan.' });
});

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    return cb(null, isOriginAllowed(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range'],
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type'],
  maxAge: 86400,
}));

app.use(express.json({ limit: '3mb' }));

// Header keamanan dasar (backend ini hanya mengirim JSON / stream media).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.ip || '');

// Health check (tanpa limiter).
app.get('/api/health', async (req, res) => {
  try {
    await DB.query('SELECT 1');
    res.json({ success: true, status: 'ok', uptime: Math.round(process.uptime()) });
  } catch (e) {
    res.status(503).json({ success: false, status: 'db_error' });
  }
});

// Streaming audio/gambar: tanpa limiter ketat (satu lagu bisa memicu banyak request Range).
app.get('/api/proxy-audio', (req, res) => streamProxy(req, res, { kind: 'audio' }));
app.get('/api/proxy-image', (req, res) => streamProxy(req, res, { kind: 'image' }));

// Limiter umum untuk endpoint lainnya.
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { success: false, status: false, message: 'Terlalu banyak request, coba lagi sebentar.' },
}));

// ── API musik (handler dipakai apa adanya dari versi sebelumnya) ──
const H = (name) => require('./handlers/' + name + '.js');
app.all('/api/search', H('search'));
app.all('/api/lyrics', H('lyrics'));
app.all('/api/lyrics1', H('lyrics1'));
app.all('/api/lyrics2', H('lyrics2'));
app.all('/api/artist', H('artist'));
app.all('/api/album', H('album'));
app.all('/api/suggest', H('suggest'));
app.all('/api/ytplay', H('ytplay'));
app.all('/api/translate', H('translate'));
app.all('/api/transcribe', H('transcribe'));

// ── Akun & sinkronisasi antar device ──
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/sync', require('./routes/sync.routes'));

app.use((req, res) => {
  res.status(404).json({ success: false, status: false, message: 'Endpoint tidak ditemukan' });
});

app.use((err, req, res, next) => {
  const code = err && (err.status || err.statusCode);
  const status = code >= 400 && code < 500 ? code : 500;
  console.error(`Server error [${status}] ${req.method} ${req.originalUrl}:`, err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  res.status(status).json({ success: false, status: false, message: status === 500 ? 'Terjadi kesalahan pada server.' : err.message });
});

(async () => {
  const ok = await DB.init();
  if (!ok) console.error('[DB] Database belum bisa dihubungi. Endpoint login/sync akan error sampai DB siap; endpoint musik tetap jalan.');
  app.listen(settings.PORT, settings.HOST, () => {
    console.log(`🎵 AustinPlay API berjalan di ${settings.HOST}:${settings.PORT}`);
    console.log('   Origin diizinkan:', settings.ALLOWED_ORIGINS.join(', ') || '(belum ada — isi FRONTEND_URL)');
  });
})();

module.exports = app;
