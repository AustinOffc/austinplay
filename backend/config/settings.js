'use strict';

// Semua konfigurasi dibaca dari environment (Startup Variables Pterodactyl / file .env).
// Tidak ada kredensial yang ditulis di sini.

// Muat .env kalau ada (tanpa dependency tambahan). Env asli dari panel tetap diutamakan.
try {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
} catch (_) { /* abaikan */ }

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const list = (v) => String(v || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

const FRONTEND_URL = (env.FRONTEND_URL || '').replace(/\/+$/, '');

const allowedOrigins = [...new Set([FRONTEND_URL, ...list(env.ALLOWED_ORIGINS)].filter(Boolean))];
if ((env.NODE_ENV || 'production') !== 'production') {
  allowedOrigins.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173');
}

module.exports = {
  NODE_ENV: env.NODE_ENV || 'production',
  PORT: Number(env.SERVER_PORT || env.PORT || 3000),
  HOST: env.HOST || '0.0.0.0',

  FRONTEND_URL,
  ALLOWED_ORIGINS: allowedOrigins,
  // Izinkan semua *.vercel.app (praktis untuk uji coba). Matikan di production: ALLOW_VERCEL_APP=false
  ALLOW_VERCEL_APP: bool(env.ALLOW_VERCEL_APP, true),

  JWT_SECRET: env.JWT_SECRET || '',
  JWT_EXPIRES_IN: env.JWT_EXPIRES_IN || '30d',

  postgres: env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL, ssl: bool(env.PG_SSL, false) ? { rejectUnauthorized: false } : undefined, max: Number(env.PG_POOL_MAX || 10) }
    : {
        host: env.PG_HOST || '172.18.0.1',
        port: Number(env.PG_PORT || 5432),
        user: env.PG_USER || 'postgres',
        password: env.PG_PASSWORD || '',
        database: env.PG_DATABASE || 'austinplay',
        ssl: bool(env.PG_SSL, false) ? { rejectUnauthorized: false } : undefined,
        max: Number(env.PG_POOL_MAX || 10),
        connectionTimeoutMillis: 8000,
        idleTimeoutMillis: 30000,
      },

  // Batas ukuran data sync per kunci (karakter)
  SYNC_MAX_VALUE_CHARS: Number(env.SYNC_MAX_VALUE_CHARS || 600000),
};
