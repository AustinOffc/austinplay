# AustinPlay

Web music player berbasis YouTube Music search/streaming. Backend Express
app yang di-deploy sebagai satu Vercel Serverless Function.

## Struktur project

```
public/           -> static site (HTML/CSS/JS)
api/               -> handler API + entrypoint Vercel
  index.js          -> entrypoint: bungkus seluruh Express app dari server.js
  search.js, lyrics.js, ytplay.js, dst -> handler tiap endpoint (dipanggil oleh server.js)
server.js          -> Express app (routing, CORS, meta-tag dinamis, proxy audio)
vercel.json        -> konfigurasi routing & bundling untuk Vercel
```

## API routes

| Route              | Keterangan                                   |
|---------------------|-----------------------------------------------|
| `/api/search`       | Pencarian lagu/album/artist                   |
| `/api/lyrics`       | Lirik (juga pakai `/api/transcribe` internal) |
| `/api/artist`       | Data artist                                   |
| `/api/album`        | Data album                                    |
| `/api/suggest`      | Saran pencarian                               |
| `/api/ytplay`       | Resolve stream audio dari YouTube             |
| `/api/translate`    | Terjemahan lirik                              |
| `/api/proxy-audio`  | Proxy streaming audio (support Range/206)     |

Tidak ada environment variable wajib.

## Deploy ke Vercel via GitHub

1. Push project ini ke repository GitHub (repo baru, bisa private).
   ```bash
   git init
   git add .
   git commit -m "AustinPlay"
   git branch -M main
   git remote add origin https://github.com/<username>/<repo>.git
   git push -u origin main
   ```
2. Buka [vercel.com](https://vercel.com) → **Add New... → Project** →
   import repo GitHub yang barusan dibuat.
3. Framework Preset: pilih **Other** (bukan Next.js/dll). Build & Output
   Settings biarkan default — tidak perlu build command, tidak perlu output
   directory.
4. Environment Variables: tidak perlu isi apa pun.
5. Klik **Deploy**.

Setelah deploy pertama, setiap `git push` ke branch `main` akan otomatis
trigger deployment baru (auto-deploy dari GitHub integration).

### Cara kerja di Vercel

- `vercel.json` me-rewrite semua request (`/(.*)`) ke satu function
  `api/index.js`, yang me-require seluruh `server.js` (Express app apa
  adanya) — jadi semua route `/api/*`, halaman dinamis (`/play/:id`,
  `/artist/:id`, `/album/:id` dengan meta-tag OG/Twitter otomatis), dan
  static file dari `public/` semuanya tetap jalan seperti aslinya.
- `includeFiles: "public/**"` di `vercel.json` memastikan folder `public/`
  ikut ter-bundle ke dalam function (karena function butuh baca file itu
  langsung via `fs`/`express.static`, bukan cuma di-serve sebagai CDN
  static asset biasa).
- `maxDuration: 60` dikasih longgar untuk endpoint `/api/ytplay` dan
  `/api/proxy-audio` yang butuh waktu lebih saat resolve/stream audio.

## Local development

```bash
npm install
npm run dev    # jalanin server.js di http://localhost:3000
```
