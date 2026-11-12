const CACHE = 'volant-plaza-v4'
const CORE = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/details.html',
    '/store.html',
    '/orders.html',
    '/notifications.html',
    '/manage.html',
    '/submit.html',
    '/faq.html',
    '/refund.html',
    '/manifest.json',
    'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600;700;800&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
]

const NAV_TIMEOUT = 3000

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE).map(k => caches.delete(k))
            ))
    );
    self.clients.claim();
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'REFRESH') {
        caches.open(CACHE).then(c => Promise.all(CORE.map(url => c.add(url))))
            .then(() => self.skipWaiting())
            .then(() => self.clients.matchAll({ includeUncontrolled: true }))
            .then(clients => clients.forEach(c => c.postMessage({ type: 'UPDATED' })));
    }
});

function cachePut(request, response) {
    if (!response || !response.ok) return;
    const copy = response.clone();
    caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
}

self.addEventListener('fetch', (e) => {
    const request = e.request;
    const url = request.url;
    if (request.method !== 'GET') return;
    if (!url.startsWith('http')) return;
    if (url.includes('/api/')) return;
    if (url.includes('firestore.googleapis') || url.includes('googleapis.com') || url.includes('gstatic.com') || url.includes('paystack.co')) {
        return;
    }

    const isNav = request.mode === 'navigate';
    const isStatic = /\.(css|js|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|eot)(\?|$)/i.test(url);

    if (isNav) {
        // Fast navigation: serve fresh HTML when quick, otherwise cached page.
        e.respondWith((async () => {
            const cached = await caches.match(request);
            const network = fetch(request).then(res => {
                cachePut(request, res);
                return res;
            });
            if (cached) {
                const timeout = new Promise(resolve => setTimeout(() => resolve(cached), NAV_TIMEOUT));
                return Promise.race([network.catch(() => cached), timeout]);
            }
            return network.catch(() => cached);
        })());
        return;
    }

    if (isStatic) {
        // Cache-first for static assets, refresh in background.
        e.respondWith((async () => {
            const cached = await caches.match(request);
            if (cached) {
                fetch(request).then(res => cachePut(request, res)).catch(() => {});
                return cached;
            }
            try {
                const res = await fetch(request);
                cachePut(request, res);
                return res;
            } catch (err) {
                return cached || Response.error();
            }
        })());
        return;
    }

    // Everything else: stale-while-revalidate.
    e.respondWith((async () => {
        const cached = await caches.match(request);
        const network = fetch(request).then(res => {
            cachePut(request, res);
            return res;
        }).catch(() => cached);
        return cached || network;
    })());
});