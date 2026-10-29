'use strict';

// Proxy streaming untuk /api/proxy-audio dan /api/proxy-image.
// Perbaikan dibanding versi lama: URL tujuan tidak boleh mengarah ke alamat internal
// (localhost, jaringan privat, metadata cloud) supaya endpoint ini tidak bisa dipakai
// untuk menembak layanan di dalam VPS/Docker (SSRF). Pengecekan dilakukan pada IP hasil
// DNS saat koneksi dibuat, jadi tidak bisa dilewati dengan DNS rebinding.

const https = require('https');
const http = require('http');
const dns = require('dns');
const net = require('net');

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

function isBlockedIp(ip) {
  if (!ip) return true;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
  try { return blocked.check(ip, family); } catch { return true; }
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (list.some(isBlockedIp)) return callback(new Error('Alamat tujuan tidak diizinkan'));
    callback(null, address, family);
  });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 3;

function parseTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedIp(host)) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return null;
  return u;
}

function open(url, headers, hops, onResponse, onError) {
  const client = url.protocol === 'https:' ? https : http;
  const req = client.get(url, { headers, lookup: safeLookup, timeout: 20000 }, (up) => {
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
      up.resume();
      if (hops >= MAX_REDIRECTS) return onError(new Error('Terlalu banyak redirect'));
      const next = parseTarget(new URL(up.headers.location, url).toString());
      if (!next) return onError(new Error('Redirect tidak diizinkan'));
      return open(next, headers, hops + 1, onResponse, onError);
    }
    onResponse(up, req);
  });
  req.on('timeout', () => req.destroy(new Error('Upstream timeout')));
  req.on('error', onError);
  return req;
}

function streamProxy(req, res, { kind }) {
  const target = parseTarget(String(req.query.url || ''));
  if (!target) return res.status(400).send('Parameter url tidak valid');

  const headers = { 'User-Agent': UA };
  if (kind === 'audio' && req.headers.range) headers.Range = req.headers.range;

  const t0 = Date.now();
  let upstreamReq = null;
  let finished = false;
  const fail = (err) => {
    if (finished) return;
    finished = true;
    if (kind === 'audio') console.error(`[PROXY] gagal ${target.hostname}: ${err && err.message ? err.message : err} (${Date.now() - t0}ms)`);
    if (!res.headersSent) res.status(502).send('Proxy error: ' + (err && err.message ? err.message : 'gagal'));
    else res.destroy();
  };

  upstreamReq = open(target, headers, 0, (up, upReq) => {
    upstreamReq = upReq;
    const type = String(up.headers['content-type'] || '');
    if (kind === 'audio') console.log(`[PROXY] ${target.hostname} -> ${up.statusCode} ${type} ${up.headers['content-length'] || '?'}B (${Date.now() - t0}ms)${req.headers.range ? ' range=' + req.headers.range : ''}`);

    if (kind === 'image') {
      const len = Number(up.headers['content-length'] || 0);
      if (!type.toLowerCase().startsWith('image/') || len > 8 * 1024 * 1024) {
        up.resume();
        return fail(new Error('Bukan gambar yang valid'));
      }
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    if (kind === 'audio' && up.statusCode < 400 && /text\/|html|json/i.test(type)) {
      up.resume();
      return fail(new Error('Sumber mengembalikan ' + type + ' (bukan audio)'));
    }

    res.status(up.statusCode);
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      if (up.headers[h]) res.setHeader(h, up.headers[h]);
    }
    if (kind === 'audio' && !res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    // ?dl=<nama file> -> paksa browser mengunduh (atribut download pada <a> diabaikan untuk URL lintas-origin).
    if (kind === 'audio' && req.query.dl) {
      const name = String(req.query.dl).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'lagu.mp3';
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }
    up.on('error', fail);
    up.pipe(res);
  }, fail);

  // Kalau pemutar berhenti/seek, hentikan unduhan ke upstream.
  res.on('close', () => { finished = true; if (upstreamReq) upstreamReq.destroy(); });
}

module.exports = { streamProxy, isBlockedIp };
