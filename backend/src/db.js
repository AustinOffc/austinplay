'use strict';

const { Pool } = require('pg');
const settings = require('../config/settings');

const pool = new Pool(settings.postgres);
pool.on('error', (err) => console.error('[DB] Error pada idle client:', err.message));

function query(text, params) {
  return pool.query(text, params);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ap_users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ap_users_username_lower_idx ON ap_users (lower(username));

CREATE TABLE IF NOT EXISTS ap_user_data (
  user_id    BIGINT NOT NULL REFERENCES ap_users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`;

// Dicoba ulang beberapa kali: saat panel start, Postgres kadang belum siap menerima koneksi.
async function init(retries = 5) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query(SCHEMA);
      const cfg = settings.postgres;
      console.log('🔌 Terhubung ke PostgreSQL:', cfg.database || '(DATABASE_URL)');
      return true;
    } catch (err) {
      console.error(`[DB] Gagal init (${i}/${retries}): ${err.message}`);
      if (i === retries) return false;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  return false;
}

module.exports = { pool, query, init };
