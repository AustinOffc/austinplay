// AustinPlay — akun & sinkronisasi antar device.
//
// Data yang disinkronkan (tetap disimpan di localStorage sebagai cache lokal, server hanya salinan):
//   - austin_liked_songs, austin_liked_artists, austin_playlists
//   - pwa_offline_tracks  (daftar lagu "download"; file/URL audio tetap per-device dan
//                          disiapkan ulang otomatis di device baru lewat rehydrateOffline)
//   - austin_auto_next
//
// Cara kerja: setiap kali kode lain menulis salah satu kunci di atas lewat localStorage.setItem,
// perubahan itu ditandai "dirty" + timestamp, lalu dikirim ke server (debounce). Server memakai
// aturan last-write-wins PER KUNCI. Login pertama di sebuah device menggabungkan (union) data lokal
// dengan data akun supaya tidak ada yang hilang.
(function () {
    'use strict';

    var LS = null;
    try { LS = window.localStorage; } catch (e) { LS = null; }

    var SYNC_KEYS = ['austin_liked_songs', 'austin_liked_artists', 'austin_playlists', 'pwa_offline_tracks', 'austin_auto_next'];
    var ARRAY_KEYS = { austin_liked_songs: 1, austin_liked_artists: 1, austin_playlists: 1, pwa_offline_tracks: 1 };
    var K_TOKEN = 'ap_token', K_USER = 'ap_user', K_META = 'ap_sync_meta', K_UID = 'ap_sync_uid', K_LAST = 'ap_sync_last';
    var POLL_MS = 60000, PUSH_DEBOUNCE_MS = 1500;

    var origSetItem = Storage.prototype.setItem;
    function lsGet(k) { try { return LS ? LS.getItem(k) : null; } catch (e) { return null; } }
    function rawSet(k, v) { try { if (LS) origSetItem.call(LS, k, v); } catch (e) { } }
    function rawDel(k) { try { if (LS) LS.removeItem(k); } catch (e) { } }
    function readJSON(k, d) { try { var v = lsGet(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }

    var Sync = window.Sync = {
        token: lsGet(K_TOKEN) || '',
        user: readJSON(K_USER, null),
        busy: false,
        applying: false,
        lastSync: Number(lsGet(K_LAST) || 0),
        error: '',
        _pushTimer: null,
        _pollTimer: null
    };

    // ── Meta per kunci: { t: timestamp versi lokal, d: true kalau belum terkirim } ──
    function getMeta() { return readJSON(K_META, {}); }
    function saveMeta(m) { rawSet(K_META, JSON.stringify(m)); }

    function toast(msg) { try { if (typeof showToast === 'function') showToast(msg); } catch (e) { } }
    function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    // ── HTTP ──
    function call(method, path, body, opts) {
        var headers = { 'Content-Type': 'application/json' };
        if (Sync.token) headers.Authorization = 'Bearer ' + Sync.token;
        var payload = body ? JSON.stringify(body) : undefined;
        var init = { method: method, headers: headers, body: payload };
        if (opts && opts.keepalive && payload && payload.length < 60000) init.keepalive = true;
        return fetch(apiUrl(path), init).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; });
        });
    }

    function setSession(token, user) {
        Sync.token = token || '';
        Sync.user = user || null;
        if (token) { rawSet(K_TOKEN, token); rawSet(K_USER, JSON.stringify(user)); }
        else { rawDel(K_TOKEN); rawDel(K_USER); }
    }

    function onUnauthorized() {
        setSession('', null);
        rawDel(K_META); rawDel(K_UID);
        Sync.error = 'Sesi berakhir, silakan login ulang.';
        toast('Sesi akun berakhir, silakan login ulang');
        refreshProfile();
    }

    // ── Hook penulisan localStorage ──
    Storage.prototype.setItem = function (k, v) {
        origSetItem.apply(this, arguments);
        try {
            if (this === LS && !Sync.applying && Sync.token && SYNC_KEYS.indexOf(k) !== -1) markDirty(k);
        } catch (e) { }
    };

    function markDirty(k) {
        var m = getMeta();
        m[k] = { t: Date.now(), d: true };
        saveMeta(m);
        pushSoon();
    }

    function pushSoon() {
        if (!Sync.token) return;
        clearTimeout(Sync._pushTimer);
        Sync._pushTimer = setTimeout(function () { Sync.sync(); }, PUSH_DEBOUNCE_MS);
    }

    // ── Merge ──
    function idOf(o) {
        if (o && typeof o === 'object') return String(o.id || o.videoId || o.artistId || o.name || JSON.stringify(o));
        return String(o);
    }

    function mergePlaylists(local, server) {
        var byId = {}, out = [];
        local.concat(server).forEach(function (p) {
            if (!p || !p.id) return;
            if (!byId[p.id]) { byId[p.id] = JSON.parse(JSON.stringify(p)); byId[p.id].songs = byId[p.id].songs || []; out.push(byId[p.id]); return; }
            var cur = byId[p.id], seen = {};
            cur.songs.forEach(function (s) { seen[s.videoId || s.id] = 1; });
            (p.songs || []).forEach(function (s) {
                var key = s.videoId || s.id;
                if (!seen[key] && cur.songs.length < 15) { cur.songs.push(s); seen[key] = 1; }
            });
            if (!cur.image && p.image) cur.image = p.image;
        });
        return out;
    }

    function mergeArrays(key, local, server) {
        if (key === 'austin_playlists') return mergePlaylists(local, server);
        var seen = {}, out = [];
        local.concat(server).forEach(function (o) {
            var id = idOf(o);
            if (!seen[id]) { seen[id] = 1; out.push(o); }
        });
        return out;
    }

    // Daftar download: lirik tidak ikut dikirim (besar, dan sudah ada di lyricsCache per device).
    function valueForPush(key, raw) {
        if (key !== 'pwa_offline_tracks') return raw;
        try {
            var arr = JSON.parse(raw);
            arr.forEach(function (o) { if (o && o.lyrics) delete o.lyrics; });
            return JSON.stringify(arr);
        } catch (e) { return raw; }
    }

    function applyLocal(key, value, t, meta, changed) {
        var out = value;
        if (key === 'pwa_offline_tracks') {
            // pertahankan lirik yang sudah ada di device ini
            try {
                var localArr = readJSON(key, []), lyr = {};
                localArr.forEach(function (o) { if (o && o.lyrics) lyr[idOf(o)] = o.lyrics; });
                var srv = JSON.parse(value);
                srv.forEach(function (o) { var l = lyr[idOf(o)]; if (l && o) o.lyrics = l; });
                out = JSON.stringify(srv);
            } catch (e) { out = value; }
        }
        Sync.applying = true;
        rawSet(key, out);
        Sync.applying = false;
        meta[key] = { t: t, d: false };
        changed.push(key);
    }

    function isNonEmptyArrayStr(s) {
        try { var a = JSON.parse(s); return Array.isArray(a) && a.length > 0; } catch (e) { return false; }
    }

    // ── Sinkronisasi utama (tarik → gabung → kirim) ──
    Sync.sync = function (opts) {
        opts = opts || {};
        if (!Sync.token) return Promise.resolve(false);
        if (Sync.busy) { Sync._again = true; return Promise.resolve(false); }
        if (!navigator.onLine) return Promise.resolve(false);
        Sync.busy = true; Sync.error = '';
        var changed = [];

        return call('GET', '/api/sync').then(function (res) {
            if (res.status === 401) { onUnauthorized(); throw new Error('unauth'); }
            if (!res.json || !res.json.success) throw new Error((res.json && res.json.message) || 'Gagal mengambil data');

            var server = res.json.data || {};
            var meta = getMeta();
            var bootstrap = !Sync.user || String(lsGet(K_UID)) !== String(Sync.user.id);
            var now = Date.now();

            SYNC_KEYS.forEach(function (k) {
                var local = lsGet(k);
                var s = server[k];
                var m = meta[k] || { t: 0, d: false };

                if (bootstrap) {
                    if (s && local !== null && ARRAY_KEYS[k] && isNonEmptyArrayStr(local)) {
                        var merged;
                        try { merged = JSON.stringify(mergeArrays(k, JSON.parse(local), JSON.parse(s.value))); } catch (e) { merged = s.value; }
                        Sync.applying = true; rawSet(k, merged); Sync.applying = false;
                        meta[k] = { t: now, d: true }; changed.push(k);
                    } else if (s) {
                        applyLocal(k, s.value, s.updatedAt, meta, changed);
                    } else if (local !== null && (!ARRAY_KEYS[k] || isNonEmptyArrayStr(local))) {
                        meta[k] = { t: now, d: true };
                    }
                    return;
                }

                if (s && s.updatedAt > m.t) {
                    applyLocal(k, s.value, s.updatedAt, meta, changed);
                } else if (m.d && (!s || m.t >= s.updatedAt)) {
                    meta[k] = m; // tetap dirty -> dikirim di bawah
                }
            });

            if (bootstrap) rawSet(K_UID, String(Sync.user.id));
            saveMeta(meta);

            var items = {}, sentT = {}, any = false;
            SYNC_KEYS.forEach(function (k) {
                if (meta[k] && meta[k].d) {
                    var raw = lsGet(k);
                    if (raw === null) return;
                    items[k] = { value: valueForPush(k, raw), updatedAt: meta[k].t };
                    sentT[k] = meta[k].t; any = true;
                }
            });
            if (!any) return null;
            return call('PUT', '/api/sync', { items: items }, { keepalive: !!opts.keepalive }).then(function (pr) {
                if (pr.status === 401) { onUnauthorized(); throw new Error('unauth'); }
                if (!pr.json || !pr.json.success) throw new Error((pr.json && pr.json.message) || 'Gagal mengirim data');
                var m2 = getMeta(), d = pr.json.data || {};
                Object.keys(d).forEach(function (k) {
                    if (d[k].applied) {
                        // jangan tandai bersih kalau user mengubah lagi saat request berjalan
                        if (m2[k] && m2[k].t === sentT[k]) m2[k] = { t: d[k].updatedAt, d: false };
                    } else {
                        applyLocal(k, d[k].value, d[k].updatedAt, m2, changed);
                    }
                });
                saveMeta(m2);
            });
        }).then(function () {
            Sync.lastSync = Date.now(); rawSet(K_LAST, String(Sync.lastSync));
            if (changed.length) { refreshUI(); toast('Data akun disinkronkan'); }
            if (changed.indexOf('pwa_offline_tracks') !== -1 || !Sync._rehydratedOnce) { Sync._rehydratedOnce = true; rehydrateOffline(); }
            return true;
        }).catch(function (e) {
            if (e && e.message !== 'unauth') Sync.error = (e && e.message) || 'Gagal sinkron';
            return false;
        }).then(function (ok) {
            Sync.busy = false;
            refreshProfile();
            if (Sync._again) { Sync._again = false; pushSoon(); }
            return ok;
        });
    };

    // ── Siapkan ulang lagu "download" di device ini (URL audio + lirik) ──
    var rehydrating = false;
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function rehydrateOffline() {
        if (rehydrating || !navigator.onLine) return;
        if (typeof getOfflineSongs !== 'function' || typeof audioUrlCache === 'undefined' || typeof API === 'undefined') return;
        var todo = getOfflineSongs().filter(function (s) { var v = s.videoId || s.id; return v && !audioUrlCache[v]; }).slice(0, 25);
        if (!todo.length) return;
        rehydrating = true;
        var done = 0;
        (function next(i) {
            if (i >= todo.length) {
                rehydrating = false;
                if (done) { toast(done + ' lagu download disiapkan di perangkat ini'); refreshUI(); }
                return;
            }
            var s = todo[i], vid = s.videoId || s.id;
            var ytUrl = s.ytUrl || ('https://youtube.com/watch?v=' + vid);
            fetch(API.ytplay, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: ytUrl, prefetch: true }) })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (d && d.result && d.result.download && d.result.download.audio) {
                        audioUrlCache[vid] = d.result.download.audio; done++;
                    }
                    if (typeof lyricsCache !== 'undefined' && !lyricsCache[vid]) {
                        var t = s.title ? '&title=' + encodeURIComponent(s.title) : '';
                        var a = s.artist ? '&artist=' + encodeURIComponent(s.artist) : '';
                        return fetch(API.lyrics + '?id=' + vid + t + a).then(function (r) { return r.json(); }).then(function (ld) {
                            if (ld && ld.status && ld.result && ld.result.lyrics) {
                                lyricsCache[vid] = { vid: vid, type: ld.result.lyrics.type || 'none', lines: ld.result.lyrics.lines || [] };
                            }
                        });
                    }
                })
                .catch(function () { })
                .then(function () {
                    if (typeof savePwaCaches === 'function') savePwaCaches();
                    return sleep(400);
                })
                .then(function () { next(i + 1); });
        })(0);
    }
    Sync.rehydrateOffline = rehydrateOffline;

    function refreshUI() {
        try {
            if (typeof S === 'undefined') return;
            if (S.at === 'library' && typeof Library !== 'undefined') Library.render();
            if (S.at === 'liked' && typeof Liked !== 'undefined') Liked.render();
            if (S.at === 'offline' && typeof OfflineView !== 'undefined') OfflineView.render();
            if (typeof updateOfflineButtons === 'function') updateOfflineButtons();
        } catch (e) { }
    }

    function refreshProfile() {
        try {
            if (document.getElementById('sync-card')) Sync.renderCard();
        } catch (e) { }
    }

    // ── Auth ──
    function authRequest(path, username, password) {
        return call('POST', path, { username: username, password: password }).then(function (res) {
            if (!res.json || !res.json.success) return { ok: false, message: (res.json && res.json.message) || 'Gagal terhubung ke server.' };
            setSession(res.json.token, res.json.user);
            Sync.error = '';
            return Sync.sync().then(function () { return { ok: true }; });
        }).catch(function () { return { ok: false, message: 'Tidak bisa menghubungi server. Cek koneksi internet.' }; });
    }
    Sync.login = function (u, p) { return authRequest('/api/auth/login', u, p); };
    Sync.register = function (u, p) { return authRequest('/api/auth/register', u, p); };

    Sync.logout = function (wipe) {
        setSession('', null);
        rawDel(K_META); rawDel(K_UID); rawDel(K_LAST);
        if (wipe) {
            SYNC_KEYS.forEach(rawDel);
            ['pwa_audio_cache', 'pwa_lyrics_cache'].forEach(rawDel);
            try { if (typeof audioUrlCache !== 'undefined') audioUrlCache = {}; if (typeof lyricsCache !== 'undefined') lyricsCache = {}; } catch (e) { }
        }
        Sync.lastSync = 0;
        refreshUI(); refreshProfile();
    };

    // ── UI kartu akun (di tab Profil) ──
    var INPUT = 'w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/40 outline-none focus:border-white/40';

    function fmtTime(t) {
        if (!t) return 'Belum pernah';
        try { return new Date(t).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; }
    }

    Sync.renderCard = function () {
        var el = document.getElementById('sync-card');
        if (!el) return;
        var html;
        if (Sync.token && Sync.user) {
            html =
                '<h3 class="text-white font-bold text-sm uppercase tracking-wider mb-2 flex items-center gap-2"><i data-lucide="user-round" class="w-4 h-4 text-white/70"></i> Akun & Sinkronisasi</h3>' +
                '<div class="flex justify-between"><span class="text-white/70 text-sm">Masuk sebagai</span><span class="text-white font-bold text-sm">' + esc(Sync.user.username) + '</span></div>' +
                '<div class="flex justify-between"><span class="text-white/70 text-sm">Sinkron terakhir</span><span class="text-white font-medium text-xs">' + (Sync.busy ? 'Menyinkronkan...' : esc(fmtTime(Sync.lastSync))) + '</span></div>' +
                (Sync.error ? '<p class="text-xs text-red-300">' + esc(Sync.error) + '</p>' : '') +
                '<p class="text-white/50 text-xs">Lagu disukai, playlist, dan daftar download ikut tersimpan di akunmu dan muncul di semua perangkat.</p>' +
                '<div class="flex gap-2 pt-1">' +
                '<button onclick="Sync.uiSyncNow()" class="flex-1 btn-chrome font-bold py-2.5 rounded-full text-xs active:scale-95 transition-all">Sinkronkan</button>' +
                '<button onclick="Sync.uiLogout()" class="flex-1 bg-white/10 text-white font-bold py-2.5 rounded-full text-xs active:scale-95 transition-all">Keluar</button>' +
                '</div>' +
                '<button onclick="Sync.uiLogoutAll()" class="text-xs text-white/60 underline active:scale-95 pt-1">Keluarkan dari semua perangkat</button>';
        } else {
            html =
                '<h3 class="text-white font-bold text-sm uppercase tracking-wider mb-2 flex items-center gap-2"><i data-lucide="user-round" class="w-4 h-4 text-white/70"></i> Akun & Sinkronisasi</h3>' +
                '<p class="text-white/60 text-xs">Masuk untuk memakai lagu disukai, playlist, dan daftar download yang sama di semua perangkat.</p>' +
                '<form onsubmit="Sync.uiSubmit(\'login\'); return false;" class="space-y-2.5">' +
                '<input id="sync-user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Username" class="' + INPUT + '" />' +
                '<input id="sync-pass" type="password" autocomplete="current-password" placeholder="Password (min. 8 karakter)" class="' + INPUT + '" />' +
                '<p id="sync-msg" class="text-xs text-red-300 min-h-[1rem]">' + esc(Sync.error) + '</p>' +
                '<div class="flex gap-2">' +
                '<button type="submit" class="flex-1 btn-chrome font-bold py-2.5 rounded-full text-xs active:scale-95 transition-all">Masuk</button>' +
                '<button type="button" onclick="Sync.uiSubmit(\'register\')" class="flex-1 bg-white/10 text-white font-bold py-2.5 rounded-full text-xs active:scale-95 transition-all">Daftar</button>' +
                '</div></form>';
        }
        el.innerHTML = html;
        if (window.lucide && typeof lucide.createIcons === 'function') try { lucide.createIcons(); } catch (e) { }
    };

    Sync.uiSubmit = function (mode) {
        var u = (document.getElementById('sync-user') || {}).value || '';
        var p = (document.getElementById('sync-pass') || {}).value || '';
        var msg = document.getElementById('sync-msg');
        u = u.trim();
        if (!u || !p) { if (msg) msg.textContent = 'Username dan password wajib diisi.'; return; }
        if (msg) { msg.className = 'text-xs text-white/70 min-h-[1rem]'; msg.textContent = 'Memproses...'; }
        (mode === 'register' ? Sync.register(u, p) : Sync.login(u, p)).then(function (r) {
            if (r.ok) { toast(mode === 'register' ? 'Akun dibuat & data disinkronkan' : 'Berhasil masuk'); Sync.renderCard(); }
            else if (msg) { msg.className = 'text-xs text-red-300 min-h-[1rem]'; msg.textContent = r.message; }
        });
    };

    Sync.uiSyncNow = function () {
        Sync.sync().then(function (ok) { toast(ok ? 'Sinkronisasi selesai' : (Sync.error || 'Sinkronisasi gagal')); refreshProfile(); });
        refreshProfile();
    };

    Sync.uiLogout = function () {
        var wipe = confirm('Hapus juga data lagu (disukai, playlist, download) dari perangkat ini?\n\nData tetap aman di akunmu. Pilih OK jika ini perangkat bersama.');
        Sync.logout(wipe);
        toast('Berhasil keluar');
    };

    Sync.uiLogoutAll = function () {
        if (!confirm('Keluarkan akun dari SEMUA perangkat, termasuk yang ini?')) return;
        call('POST', '/api/auth/logout-all').then(function () { Sync.logout(false); toast('Semua perangkat dikeluarkan'); })
            .catch(function () { toast('Gagal menghubungi server'); });
    };

    // ── Pemicu ──
    function start() {
        if (!Sync.token) return;
        Sync.sync();
        clearInterval(Sync._pollTimer);
        Sync._pollTimer = setInterval(function () { if (!document.hidden && Sync.token) Sync.sync(); }, POLL_MS);
    }
    document.addEventListener('visibilitychange', function () {
        if (!Sync.token) return;
        if (document.hidden) {
            var m = getMeta();
            if (SYNC_KEYS.some(function (k) { return m[k] && m[k].d; })) Sync.sync({ keepalive: true });
        } else {
            Sync.sync();
        }
    });
    window.addEventListener('online', function () { if (Sync.token) Sync.sync(); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 600); });
    else setTimeout(start, 600);

    // Setelah login baru dari kartu akun, aktifkan polling.
    var origLogin = Sync.login, origRegister = Sync.register;
    function afterAuth(p) { return p.then(function (r) { if (r.ok) start(); return r; }); }
    Sync.login = function (u, p) { return afterAuth(origLogin(u, p)); };
    Sync.register = function (u, p) { return afterAuth(origRegister(u, p)); };
})();
