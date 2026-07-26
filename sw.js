// ══════════════════════════════════════════════════════════════
// Kanyadet School Portal — Service Worker
// Strategy (STRIPPED-DOWN v4):
//   Caching is now limited to ONLY what's needed to open the app and
//   use Quick Entry offline (so a teacher can keep typing scores into
//   the shared draft with no signal — Firestore/RTDB's own IndexedDB
//   persistence + the app's localStorage draft mirror handle the actual
//   score data; this file only has to make sure the SHEET ITSELF can
//   load with no network).
//
//   Everything else — Chart.js, XLSX export, jsPDF/report-card
//   generation, Google Fonts, and any other runtime asset — is no
//   longer cached at all. Those features simply require an internet
//   connection, same as before if the cache had never warmed up.
//   Nothing about their normal (online) behavior changes.
//
//   • Core shell + Quick Entry assets → cache-first, background refresh
//   • Everything else                → network-only, never cached
//   • Firebase / Google API traffic   → never intercepted (unchanged)
//
// IMPORTANT: bump CACHE_VERSION every time you deploy changes to any
// core file below, or returning users will keep seeing the old version.
// ══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'v4'; // bumped: cache scope reduced to Quick-Entry-only assets
const SHELL_CACHE = `kanyadet-shell-${CACHE_VERSION}`;

// ── CORE_URLS ────────────────────────────────────────────────────
// Only what's required to (a) boot the app shell and (b) render +
// operate the Quick Entry score sheet offline. Nothing here is
// optional — remove something only if it's truly not needed to reach
// and use Quick Entry.
const CORE_URLS = [
  './',
  './index.html',
  './image-popup.js',
  './images/logo.png',
  './Report-Cards/css/swalOnly.css', // sweetalert theming — used for Quick Entry's own confirm/error dialogs

  // SweetAlert2 — powers save/submit/error dialogs throughout Quick Entry
  'https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.css',
  'https://cdn.jsdelivr.net/npm/sweetalert2@11',

  // jQuery + DataTables + ColumnControl + FixedColumns — literally render
  // and drive the Quick Entry score sheet (sort/search/frozen columns).
  'https://code.jquery.com/jquery-3.7.1.min.js',
  'https://cdn.datatables.net/2.3.8/css/dataTables.dataTables.min.css',
  'https://cdn.datatables.net/2.3.8/js/dataTables.min.js',
  'https://cdn.datatables.net/columncontrol/1.2.1/css/columnControl.dataTables.min.css',
  'https://cdn.datatables.net/columncontrol/1.2.1/js/dataTables.columnControl.min.js',
  'https://cdn.datatables.net/fixedcolumns/5.0.4/css/fixedColumns.dataTables.min.css',
  'https://cdn.datatables.net/fixedcolumns/5.0.4/js/dataTables.fixedColumns.min.js',

  // Firebase SDK modules — required just to boot the app / sign in / read
  // & write the Quick Entry shared draft. Live on gstatic.com/firebasejs,
  // which is otherwise in NEVER_INTERCEPT below (that domain also serves
  // live config data) — these 4 exact files are the carved-out exception
  // (see ALWAYS_CACHE_EXACT) so a reload while offline never depends on
  // the browser's own (evictable) HTTP cache for something this critical.
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js',
];

// Resolve everything to absolute URLs up front so fetch-time comparisons
// against request.url (always absolute) are simple exact-match lookups.
const CORE_URL_SET = new Set(CORE_URLS.map((u) => new URL(u, self.location).href));

// Exact files that must be served from cache-first even though their
// domain is otherwise in NEVER_INTERCEPT — these are static SDK code, not
// live backend calls, so caching them is safe and actually necessary for
// the app to boot at all when offline.
const ALWAYS_CACHE_EXACT = new Set([
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js',
]);

// Domains that must ALWAYS go to the network untouched.
// (Auth, Firestore, Realtime Database, Google Sign-In popups, etc.)
const NEVER_INTERCEPT = [
  'googleapis.com',
  'firebaseio.com',
  'firebaseapp.com',
  'firebase.google.com',
  'gstatic.com/firebasejs',
  'accounts.google.com',
  'identitytoolkit',
];

function shouldBypass(url) {
  if (ALWAYS_CACHE_EXACT.has(url)) return false; // SDK code, not live backend traffic — safe & necessary to cache
  return NEVER_INTERCEPT.some((d) => url.includes(d));
}

// ── INSTALL: precache ONLY the core shell + Quick Entry assets ─────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // allSettled so one bad path doesn't block the whole install.
      Promise.allSettled(
        CORE_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] precache skipped:', url, err.message))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: drop old cache versions (this also clears out every
// large runtime-cached file — images, exports, chart libs, fonts, etc.
// — from anyone's previous install of this SW) ──────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: route requests ───────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never intercept writes
  const url = request.url;

  if (shouldBypass(url)) return; // let Firebase/Google traffic pass straight through

  // The app shell page itself → network-first, cache fallback, so a
  // reload while offline still boots straight into the last-known UI
  // (including Quick Entry) instead of a blank/broken page.
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirstShell(request));
    return;
  }

  // Only the explicit Quick-Entry/core asset list is cached at all.
  if (CORE_URL_SET.has(url)) {
    event.respondWith(cacheFirstWithRevalidate(request));
    return;
  }

  // Everything else (Chart.js, XLSX export, jsPDF, fonts, images,
  // report-card assets, anything not in CORE_URLS) → network-only,
  // never cached. Requires internet; normal online behavior is
  // unaffected, it just no longer bloats the cache.
  event.respondWith(fetch(request).catch(() => new Response('', { status: 504 })));
});

async function networkFirstShell(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // last resort: try the root shell page so the app still boots
    const shellFallback = await caches.match('./index.html');
    if (shellFallback) return shellFallback;
    return new Response(
      '<h1>Offline</h1><p>Connect once online to load the app, then Quick Entry will keep working offline.</p>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}

async function cacheFirstWithRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.status === 200) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await networkFetch) || new Response('', { status: 504 });
}
