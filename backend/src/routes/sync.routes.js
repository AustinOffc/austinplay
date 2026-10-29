'use strict';

const express = require('express');
const DB = require('../db');
const settings = require('../../config/settings');
const { requireAuth } = require('../auth');

const router = express.Router();

// Kunci yang boleh disinkronkan (whitelist). Nilai disimpan apa adanya (string JSON dari localStorage).
// type: 'array' = harus JSON array, 'scalar' = string pendek.
const KEYS = {
  austin_liked_songs: 'array',
  austin_liked_artists: 'array',
  austin_playlists: 'array',
  pwa_offline_tracks: 'array', // daftar lagu "download" (metadata saja, file audio tetap per-device)
  austin_volume: 'scalar',
  austin_playback_rate: 'scalar',
  austin_auto_next: 'scalar',
};

router.use(requireAuth);

// Ambil semua data milik user.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await DB.query('SELECT key, value, updated_at FROM ap_user_data WHERE user_id = $1', [req.user.id]);
    const data = {};
    for (const r of rows) data[r.key] = { value: r.value, updatedAt: Number(r.updated_at) };
    res.json({ success: true, data, serverTime: Date.now() });
  } catch (err) {
    next(err);
  }
});

// Kirim perubahan: { items: { <key>: { value: "<string>", updatedAt: <ms> } } }
// Aturan: per kunci, versi dengan updatedAt terbaru menang (last-write-wins).
// Balasan memuat kondisi terkini di server untuk kunci yang dikirim.
router.put('/', async (req, res, next) => {
  try {
    const items = req.body && req.body.items;
    if (!items || typeof items !== 'object') {
      return res.status(400).json({ success: false, message: 'Format data tidak valid.' });
    }

    const now = Date.now();
    const result = {};
    for (const key of Object.keys(items)) {
      const type = KEYS[key];
      if (!type) continue; // kunci tak dikenal diabaikan

      const item = items[key] || {};
      const value = item.value;
      if (typeof value !== 'string' || value.length > settings.SYNC_MAX_VALUE_CHARS) {
        return res.status(400).json({ success: false, message: `Data "${key}" terlalu besar atau tidak valid.` });
      }
      if (type === 'array') {
        let parsed;
        try { parsed = JSON.parse(value); } catch { parsed = null; }
        if (!Array.isArray(parsed)) {
          return res.status(400).json({ success: false, message: `Data "${key}" harus berupa daftar.` });
        }
      } else if (value.length > 32) {
        return res.status(400).json({ success: false, message: `Data "${key}" tidak valid.` });
      }

      // updatedAt dari client dibatasi: tidak boleh jauh di masa depan (jam device salah).
      let updatedAt = Number(item.updatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) updatedAt = now;
      if (updatedAt > now + 60 * 1000) updatedAt = now;

      const { rows } = await DB.query(
        `INSERT INTO ap_user_data (user_id, key, value, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
           WHERE ap_user_data.updated_at < EXCLUDED.updated_at
         RETURNING value, updated_at`,
        [req.user.id, key, value, updatedAt]
      );
      if (rows[0]) {
        result[key] = { value: rows[0].value, updatedAt: Number(rows[0].updated_at), applied: true };
      } else {
        const cur = await DB.query('SELECT value, updated_at FROM ap_user_data WHERE user_id = $1 AND key = $2', [req.user.id, key]);
        result[key] = { value: cur.rows[0].value, updatedAt: Number(cur.rows[0].updated_at), applied: false };
      }
    }
    res.json({ success: true, data: result, serverTime: now });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
