'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const DB = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');

const router = express.Router();

// IP asli user: Cloudflare Tunnel mengirim CF-Connecting-IP.
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.ip || '');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { success: false, message: 'Terlalu banyak percobaan, coba lagi beberapa menit lagi.' },
});

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,24}$/;

function validate(body) {
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');
  if (!USERNAME_RE.test(username)) {
    return { error: 'Username 3-24 karakter: huruf, angka, titik, atau underscore.' };
  }
  if (password.length < 8 || password.length > 128) {
    return { error: 'Password minimal 8 karakter.' };
  }
  return { username, password };
}

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ success: false, message: v.error });

    const hash = hashPassword(v.password);
    let user;
    try {
      const { rows } = await DB.query(
        'INSERT INTO ap_users (username, password_hash, last_login_at) VALUES ($1, $2, now()) RETURNING id, username, token_version',
        [v.username, hash]
      );
      user = rows[0];
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ success: false, message: 'Username sudah dipakai.' });
      throw err;
    }
    res.json({ success: true, token: signToken(user), user: { id: user.id, username: user.username } });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password || password.length > 128) {
      return res.status(400).json({ success: false, message: 'Username dan password wajib diisi.' });
    }
    const { rows } = await DB.query(
      'SELECT id, username, password_hash, token_version FROM ap_users WHERE lower(username) = lower($1)',
      [username]
    );
    const user = rows[0];
    // Selalu hitung hash supaya waktu respons tidak membocorkan apakah username ada.
    const ok = verifyPassword(password, user ? user.password_hash : 'scrypt$00$00');
    if (!user || !ok) return res.status(401).json({ success: false, message: 'Username atau password salah.' });

    DB.query('UPDATE ap_users SET last_login_at = now() WHERE id = $1', [user.id]).catch(() => {});
    res.json({ success: true, token: signToken(user), user: { id: user.id, username: user.username } });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, user: { id: req.user.id, username: req.user.username } });
});

// Keluarkan akun dari SEMUA device (token lama jadi tidak berlaku).
router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await DB.query('UPDATE ap_users SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const oldPassword = String((req.body && req.body.oldPassword) || '');
    const newPassword = String((req.body && req.body.newPassword) || '');
    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 8 karakter.' });
    }
    const { rows } = await DB.query('SELECT id, username, password_hash, token_version FROM ap_users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user || !verifyPassword(oldPassword, user.password_hash)) {
      return res.status(401).json({ success: false, message: 'Password lama salah.' });
    }
    const upd = await DB.query(
      'UPDATE ap_users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING id, username, token_version',
      [hashPassword(newPassword), user.id]
    );
    // Device lain otomatis keluar; device ini dapat token baru.
    res.json({ success: true, token: signToken(upd.rows[0]) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
