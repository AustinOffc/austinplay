'use strict';

// Provider cadangan: yt-dlp (ambil URL audio langsung dari YouTube).
// - Binary standalone diunduh otomatis dari GitHub saat pertama kali dipakai (sama seperti cloudflared di start.sh).
// - URL googlevideo terikat ke IP server ini, jadi harus diputar lewat /api/proxy-audio (frontend otomatis
//   melakukannya untuk URL yang diberi tanda "#via-proxy").
// Env opsional:
//   YTDLP_BIN      path binary (default: backend/yt-dlp)
//   YTDLP_COOKIES  path file cookies.txt (kalau YouTube minta "confirm you're not a bot")
//   YTDLP_PROXY    proxy untuk yt-dlp (mis. http://user:pass@host:port)
//   YTDLP_DISABLE  isi 1 untuk mematikan provider ini

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const BIN = process.env.YTDLP_BIN || path.join(__dirname, '..', 'yt-dlp');
const DL_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const MAX_PARALLEL = 2;

let installing = null;
let running = 0;
const waiters = [];

function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('terlalu banyak redirect'));
    https.get(url, { headers: { 'User-Agent': 'austinplay' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => { try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); } }));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

function ensureBin() {
  if (fs.existsSync(BIN)) return Promise.resolve();
  if (!installing) {
    console.log('[YTDLP] Mengunduh yt-dlp...');
    installing = download(DL_URL, BIN)
      .then(() => { fs.chmodSync(BIN, 0o755); console.log('[YTDLP] yt-dlp siap'); })
      .finally(() => { installing = null; });
  }
  return installing;
}

async function acquire() {
  if (running < MAX_PARALLEL) { running++; return; }
  await new Promise((r) => waiters.push(r));
  running++;
}
function release() { running--; const n = waiters.shift(); if (n) n(); }

function run(args, signal) {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { timeout: 40000, maxBuffer: 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(String(stdout || ''));
    });
  });
}

async function getAudio(videoId, signal) {
  if (process.env.YTDLP_DISABLE === '1') throw new Error('yt-dlp dimatikan');
  await ensureBin();
  await acquire();
  try {
    const base = [
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--no-playlist', '--no-warnings', '--socket-timeout', '15',
      '--print', '%(duration)s', '--print', 'urls',
    ];
    if (process.env.YTDLP_COOKIES) base.push('--cookies', process.env.YTDLP_COOKIES);
    if (process.env.YTDLP_PROXY) base.push('--proxy', process.env.YTDLP_PROXY);
    const target = 'https://www.youtube.com/watch?v=' + videoId;

    let out;
    try {
      out = await run([...base, '--js-runtimes', 'node', target], signal);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      // binary lama yang belum mengenal --js-runtimes -> ulangi tanpa opsi itu
      if (/no such option|unrecognized arguments/i.test(e.stderr || '')) out = await run([...base, target], signal);
      else throw Object.assign(new Error('yt-dlp: ' + String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 300)), { cause: e });
    }
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const url = lines.find((l) => /^https?:\/\//i.test(l));
    if (!url) throw new Error('yt-dlp tidak mengembalikan URL');
    const dur = parseInt(lines.find((l) => /^\d+$/.test(l)), 10);
    return { url, duration: Number.isFinite(dur) ? dur : null };
  } finally {
    release();
  }
}

module.exports = { getAudio };
