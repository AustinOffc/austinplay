# Backend AustinPlay di Pterodactyl (via Cloudflare Tunnel)

Backend ini **API-only** (Express). Isinya: endpoint musik lama (`/api/search`, `/api/lyrics`, `/api/ytplay`, dst),
proxy audio/gambar, serta yang baru: **akun (login) dan sinkronisasi antar device** dengan PostgreSQL.
Frontend statis ada di `../frontend` dan di-deploy ke Vercel.

## 1. Cloudflare Tunnel
1. Zero Trust → Networks → Tunnels → Create tunnel, mis. `austinplay-backend`.
2. Public Hostname: mis. `api-play.domainmu.com` → Service `HTTP://localhost:<SERVER_PORT>` (port allocation server Pterodactyl).
3. Salin token tunnel.

## 2. Server Pterodactyl
1. Upload isi folder `backend/` (tanpa `node_modules`).
2. Startup Variables / Environment (lihat `.env.example`). Yang wajib:
   | Variabel | Isi |
   |---|---|
   | `FRONTEND_URL` | domain Vercel, mis. `https://austinplay.vercel.app` |
   | `JWT_SECRET` | string acak panjang: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `PG_HOST` | `172.18.0.1` (gateway Docker, dijangkau dari dalam container) |
   | `PG_PORT` | `10663` |
   | `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` | kredensial Postgres-mu |
   | `ENABLE_CF_TUNNEL` / `CF_TOKEN` | `true` + token tunnel (nama mengikuti egg ALL-IN-ONE, sesuaikan kalau beda) |
3. Startup Command: `bash start.sh`. Jalankan `npm install`, lalu start.
4. Tes `https://<domain-backend>/api/health` → harus `{"success":true,"status":"ok"}`.
   Kalau `db_error`: cek `PG_*`, dan pastikan Postgres menerima koneksi dari jaringan Docker
   (`listen_addresses` + `pg_hba.conf` untuk `172.16.0.0/12`).

Tabel `ap_users` dan `ap_user_data` dibuat otomatis saat server start (tidak mengganggu tabel lain; semua berawalan `ap_`).
Sebaiknya buat database/user khusus untuk AustinPlay.

## Endpoint baru
| Route | Fungsi |
|---|---|
| `POST /api/auth/register` `{username,password}` | daftar (username 3-24 huruf/angka/`_`/`.`, password min. 8) |
| `POST /api/auth/login` | login, balasan berisi `token` (Bearer) |
| `GET /api/auth/me` | cek sesi |
| `POST /api/auth/change-password` | ganti password (device lain otomatis keluar) |
| `POST /api/auth/logout-all` | keluarkan dari semua device |
| `GET/PUT /api/sync` | ambil / kirim data (liked, playlist, daftar download, auto-next) |
| `GET /api/proxy-audio?url=` | stream audio (+ `&dl=nama.mp3` untuk unduh file) |
| `GET /api/proxy-image?url=` | proxy gambar cover |

## Keamanan
- Login memakai token **Bearer** (disimpan di localStorage frontend), jadi tidak ada masalah cookie lintas-domain dan CSRF.
- Password di-hash scrypt; login/daftar dibatasi 20 percobaan per 15 menit per IP.
- CORS hanya untuk `FRONTEND_URL` + `ALLOWED_ORIGINS` (+ `*.vercel.app` selama `ALLOW_VERCEL_APP=true`; **set `false` setelah pakai domain sendiri**).
- Proxy audio/gambar menolak tujuan ke jaringan internal (localhost, 172.x/10.x/192.168.x, metadata cloud) agar tidak bisa dipakai menembak layanan di VPS-mu.
- Catatan: rate limit memakai header `CF-Connecting-IP`; jangan buka port backend langsung ke internet, biarkan hanya lewat tunnel.

## Yang diubah dari versi Vercel lama
- `server.js` monolit + `api/*.js` → `src/server.js` + `src/handlers/*.js` (handler musik tidak diubah).
- Tidak ada lagi static file / injeksi meta tag di backend (dipindah ke Vercel function di frontend).
- `/api/proxy-audio` ditulis ulang (redirect benar, SSRF guard, dukungan unduh). `/api/proxy-image` ditambahkan
  (dipakai pemutar mini tapi sebelumnya tidak ada rutenya).
