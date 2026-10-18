// Alamat backend API AustinPlay (server Pterodactyl lewat Cloudflare Tunnel).
// GANTI dengan domain backend-mu, tanpa slash di akhir. Isi '' untuk same-origin (dev lokal).
window.API_BASE_URL = 'https://austinplay.austinstore.id';

window.apiUrl = function (path) {
    return String(window.API_BASE_URL || '').replace(/\/+$/, '') + path;
};
