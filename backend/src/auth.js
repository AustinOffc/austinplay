'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const settings = require('../config/settings');
const DB = require('./db');

const SECRET = settings.JWT_SECRET;
if (!SECRET || SECRET.length < 16) {
  if (settings.NODE_ENV === 'production') {
    console.error('[FATAL] JWT_SECRET belum di-set (minimal 16 karakter). Server berhenti.');
    process.exit(1);
  }
  console.warn('[WARN] JWT_SECRET kosong; memakai secret sementara untuk development.');
}
const EFFECTIVE_SECRET = SECRET || 'dev_only_secret_change_me_' + crypto.randomBytes(8).toString('hex');

// ── Password: scrypt bawaan Node (tanpa dependency native) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function signToken(user) {
  return jwt.sign({ uid: user.id, tv: user.token_version }, EFFECTIVE_SECRET, { expiresIn: settings.JWT_EXPIRES_IN });
}

function getBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

// Wajib login. Token dikirim lewat header Authorization: Bearer <token>
// (bukan cookie, jadi aman dari CSRF dan tidak terkendala aturan cookie lintas-domain).
async function requireAuth(req, res, next) {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ success: false, message: 'Belum login.' });
    let payload;
    try {
      payload = jwt.verify(token, EFFECTIVE_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Sesi berakhir, silakan login ulang.' });
    }
    const { rows } = await DB.query('SELECT id, username, token_version FROM ap_users WHERE id = $1', [payload.uid]);
    const user = rows[0];
    if (!user || user.token_version !== payload.tv) {
      return res.status(401).json({ success: false, message: 'Sesi berakhir, silakan login ulang.' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { hashPassword, verifyPassword, signToken, requireAuth };
