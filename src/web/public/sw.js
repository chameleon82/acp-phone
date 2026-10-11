// Calls, transcripts, audio and application assets always use the network.
// Cache only the offline page; updates wait until the old app is closed.
const prefix = `acp-phone-offline:${self.registration.scope}:`;
const cacheName = `${prefix}v1`;
const offlineUrl = new URL('offline.html', self.registration.scope).href;

self.addEventListener('install', event => {
    event.waitUntil(caches.open(cacheName).then(cache => cache.add(offlineUrl)));
});
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        for (const name of await caches.keys()) {
            if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
        }
        await self.clients.claim();
    })());
});
self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    const scope = new URL(self.registration.scope);
    if (request.method !== 'GET' || request.mode !== 'navigate'
        || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)
        || url.pathname.startsWith(`${scope.pathname}api/`)) return;
    event.respondWith(fetch(request).catch(async () => {
        const cached = await caches.open(cacheName).then(cache => cache.match(offlineUrl));
        return cached ?? new Response('ACP Phone server is unavailable. Reconnect and try again.', {
            status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'},
        });
    }));
});
