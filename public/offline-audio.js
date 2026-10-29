// OfflineAudio — menyimpan FILE audio asli (blob) di IndexedDB.
// Sebelumnya mode offline hanya menyimpan link audio (yang butuh internet & bisa kadaluarsa),
// makanya lagu ada di daftar Offline tapi tidak bisa diputar saat tidak ada koneksi.
(function () {
    'use strict';

    var DB_NAME = 'austinplay-offline', STORE = 'audio';
    var ids = new Set();          // videoId yang audionya sudah ada di perangkat
    var inflight = {};            // videoId -> Promise (sedang diunduh)
    var dbp = null;
    var backfilling = false;
    var failed = new Set();       // gagal diunduh di sesi ini -> jangan diulang terus-menerus
    var MIN_BYTES = 30000;        // file lebih kecil dari ini dianggap bukan audio valid

    function openDb() {
        if (dbp) return dbp;
        dbp = new Promise(function (resolve, reject) {
            if (!window.indexedDB) { reject(new Error('IndexedDB tidak tersedia')); return; }
            var rq = indexedDB.open(DB_NAME, 1);
            rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE); };
            rq.onsuccess = function () { resolve(rq.result); };
            rq.onerror = function () { dbp = null; reject(rq.error); };
        });
        return dbp;
    }

    function tx(mode, fn) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var t = db.transaction(STORE, mode), rq = fn(t.objectStore(STORE));
                t.oncomplete = function () { resolve(rq ? rq.result : undefined); };
                t.onerror = t.onabort = function () { reject(t.error); };
            });
        });
    }

    function notify() {
        try { window.dispatchEvent(new CustomEvent('offlineaudio:change')); } catch (e) { }
    }

    var ready = tx('readonly', function (st) { return st.getAllKeys(); })
        .then(function (keys) { (keys || []).forEach(function (k) { ids.add(k); }); })
        .catch(function () { });

    // Minta browser supaya data ini tidak dihapus otomatis saat storage penuh.
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }

    function vidOf(track) { return track && (track.videoId || track.id); }

    function has(vid) { return ids.has(vid); }

    function get(vid) {
        return ready.then(function () {
            if (!ids.has(vid)) return null;
            return tx('readonly', function (st) { return st.get(vid); }).then(function (rec) {
                if (!rec || !rec.blob) { ids.delete(vid); return null; }
                return rec.blob;
            });
        }).catch(function () { return null; });
    }

    function put(vid, blob) {
        return tx('readwrite', function (st) {
            return st.put({ blob: blob, size: blob.size, savedAt: Date.now() }, vid);
        }).then(function () { ids.add(vid); notify(); });
    }

    function del(vid) {
        ids.delete(vid);
        return tx('readwrite', function (st) { return st.delete(vid); })
            .then(notify).catch(function () { });
    }

    // Ambil link audio (dari cache atau minta server).
    async function getRemoteUrl(track, force) {
        var vid = vidOf(track);
        if (!force && typeof audioUrlCache !== 'undefined' && audioUrlCache[vid]) return audioUrlCache[vid];
        var ytUrl = track.ytUrl || ('https://youtube.com/watch?v=' + vid);
        for (var i = 0; i < 3; i++) {
            if (i > 0) await new Promise(function (r) { setTimeout(r, 1200 * i); });
            try {
                var r = await fetch(API.ytplay, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: ytUrl, refresh: !!force })
                });
                var d = await r.json().catch(function () { return null; });
                if (d && d.result && d.result.download && d.result.download.audio) {
                    var u = d.result.download.audio;
                    if (typeof audioUrlCache !== 'undefined') {
                        audioUrlCache[vid] = u;
                        if (typeof savePwaCaches === 'function') savePwaCaches();
                    }
                    return u;
                }
            } catch (e) { }
        }
        return null;
    }

    // Unduh file audio ke perangkat. Resolve true kalau sukses.
    function download(track) {
        var vid = vidOf(track);
        if (!vid) return Promise.resolve(false);
        if (ids.has(vid)) return Promise.resolve(true);
        if (inflight[vid]) return inflight[vid];
        if (!navigator.onLine) return Promise.resolve(false);

        notify();
        inflight[vid] = (async function () {
            await ready;
            for (var attempt = 0; attempt < 2; attempt++) {
                // percobaan ke-2: minta link baru (link lama mungkin sudah kadaluarsa)
                var raw = await getRemoteUrl(track, attempt > 0);
                if (!raw) continue;
                try {
                    var res = await fetch(apiUrl('/api/proxy-audio?url=' + encodeURIComponent(raw)));
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    var blob = await res.blob();
                    var type = (blob.type || '').toLowerCase();
                    if (blob.size < MIN_BYTES || /text|html|json/.test(type)) throw new Error('bukan file audio');
                    await put(vid, blob);
                    return true;
                } catch (e) {
                    try { console.warn('[offline-audio] gagal unduh', vid, e && e.message); } catch (x) { }
                }
            }
            return false;
        })().then(function (ok) {
            delete inflight[vid];
            if (!ok) failed.add(vid);
            notify();
            return ok;
        });
        return inflight[vid];
    }

    // Unduh otomatis semua lagu di daftar Offline yang filenya belum ada (mis. lagu yang disimpan versi lama).
    async function backfill() {
        if (backfilling || !navigator.onLine || typeof getOfflineSongs !== 'function') return;
        await ready;
        var todo = getOfflineSongs().filter(function (s) { var v = vidOf(s); return v && !ids.has(v) && !failed.has(v); });
        if (!todo.length) return;
        backfilling = true;
        var okCount = 0;
        try {
            for (var i = 0; i < todo.length; i++) {
                if (!navigator.onLine) break;
                if (await download(todo[i])) okCount++;
            }
        } finally { backfilling = false; }
        if (okCount && typeof showToast === 'function') showToast(okCount + ' lagu siap diputar offline');
    }

    function isBusy(vid) { return !!inflight[vid]; }

    window.OfflineAudio = {
        ready: ready, has: has, get: get, put: put, del: del,
        download: download, backfill: backfill, isBusy: isBusy
    };

    window.addEventListener('online', function () { failed.clear(); setTimeout(backfill, 1500); });
    window.addEventListener('load', function () { setTimeout(backfill, 4000); });
})();
