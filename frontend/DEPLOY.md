# Frontend AustinPlay di Vercel

Folder ini berisi static site (`public/`), `vercel.json`, dan satu Vercel Function (`api/page.js`) untuk meta tag
preview link `/play/:id`, `/artist/:id`, `/album/:id`. Semua panggilan API langsung ke backend (Pterodactyl).

## Langkah
1. Backend jalan dulu (lihat `../backend/DEPLOY.md`) dan `https://<domain-backend>/api/health` sudah OK.
2. Edit **`public/config.js`**: ganti `window.API_BASE_URL` dengan domain backend (tanpa slash di akhir).
3. Push ke GitHub, buat project Vercel baru, **Root Directory = folder `frontend/`**, Framework Preset: Other, tanpa build command.
4. Tidak ada Environment Variable yang diperlukan.
5. Isi `FRONTEND_URL` di backend dengan domain Vercel-mu (atau domain custom) agar CORS mengizinkan.

## Catatan
- Setelah update file JS, naikkan angka `?v=` di `public/index.html` dan versi cache di `public/sw.js`
  agar user mendapat versi baru.
- Audio distream langsung dari domain backend (bukan lewat Vercel) supaya tidak kena batas durasi/bandwidth function.
- Login memakai token Bearer di localStorage; tidak butuh cookie.
