// Vercel Function: menyajikan index.html dengan meta tag OG/Twitter dinamis untuk
// /play/:id, /artist/:id, dan /album/:id (supaya preview link di WhatsApp/Telegram bagus).
// Pengganti logika yang dulu ada di server.js. Nilai dari query string di-escape agar
// tidak bisa menyisipkan HTML/script.
const fs = require('fs');
const path = require('path');

const DEFAULT_COVER = 'https://www.gobox.my.id/file/R0ym4wqfznmp.png';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const clip = (s, n) => String(s || '').slice(0, n);
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? clip(u, 500) : '');

function loadIndex() {
  const candidates = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(process.cwd(), 'public', 'index.html'),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8'); } catch (_) { /* coba berikutnya */ }
  }
  return null;
}

module.exports = (req, res) => {
  const html = loadIndex();
  if (!html) return res.status(500).send('index.html tidak ditemukan');

  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const u = new URL(req.url, `${proto}://${host}`);
  const parts = u.pathname.split('/').filter(Boolean);
  const kind = parts[0];
  const id = clip(parts[1] || '', 64).replace(/[^A-Za-z0-9_-]/g, '');
  const q = (k) => clip(u.searchParams.get(k), 200);
  const qCover = safeUrl(u.searchParams.get('cover') || u.searchParams.get('thumb'));

  let title = 'AustinPlay', desc = 'AustinPlay - Web Music Player', cover = qCover || DEFAULT_COVER;
  if (kind === 'play' && id) {
    const t = q('title'), a = q('artist');
    title = t ? (a ? `${t} - ${a}` : t) : 'Dengarkan Musik - AustinPlay';
    desc = `Dengarkan ${t || 'lagu favoritmu'} di AustinPlay Web Music Player`;
    cover = qCover || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  } else if (kind === 'artist') {
    const n = q('name') || q('title');
    title = n ? `${n} (Artist) - AustinPlay` : 'Artist - AustinPlay';
    desc = n ? `Dengarkan lagu & album terbaik dari ${n} di AustinPlay` : 'Dengarkan lagu & album dari artist favoritmu di AustinPlay';
  } else if (kind === 'album') {
    const t = q('title'), a = q('artist');
    title = t ? (a ? `${t} - ${a} (Album) - AustinPlay` : `${t} (Album) - AustinPlay`) : 'Album - AustinPlay';
    desc = t ? `Dengarkan album ${t} di AustinPlay` : 'Dengarkan album favoritmu di AustinPlay';
  }

  const T = esc(title), D = esc(desc), C = esc(cover);
  const pageUrl = esc(`${proto}://${host}${u.pathname}${u.search}`);

  const out = html
    .replace(/<title>.*?<\/title>/i, () => `<title>${T}</title>`)
    .replace(/<meta property="og:title" content=".*?"\s*\/?>/i, () => `<meta property="og:title" content="${T}">`)
    .replace(/<meta property="og:description" content=".*?"\s*\/?>/i, () => `<meta property="og:description" content="${D}">`)
    .replace(/<meta property="og:image" content=".*?"\s*\/?>/i, () => `<meta property="og:image" content="${C}">`)
    .replace(/<meta property="og:image:secure_url" content=".*?"\s*\/?>/i, () => `<meta property="og:image:secure_url" content="${C}">`)
    .replace(/<meta property="og:url" content=".*?"\s*\/?>/i, () => `<meta property="og:url" content="${pageUrl}">`)
    .replace(/<meta name="twitter:title" content=".*?"\s*\/?>/i, () => `<meta name="twitter:title" content="${T}">`)
    .replace(/<meta name="twitter:description" content=".*?"\s*\/?>/i, () => `<meta name="twitter:description" content="${D}">`)
    .replace(/<meta name="twitter:image" content=".*?"\s*\/?>/i, () => `<meta name="twitter:image" content="${C}">`)
    .replace(/<meta name="twitter:image:src" content=".*?"\s*\/?>/i, () => `<meta name="twitter:image:src" content="${C}">`)
    .replace(/<link rel="icon".*?>/i, () => `<link rel="icon" type="image/jpeg" href="${C}">`)
    .replace(/<link rel="apple-touch-icon".*?>/i, () => `<link rel="apple-touch-icon" href="${C}">`);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.status(200).send(out);
};
