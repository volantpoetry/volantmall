const CACHE = 'volant-mall-v2'

const CORE = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/details.html',
    '/store.html',
    '/orders.html',
    '/faq.html',
    '/refund.html',
    '/manifest.json',
    'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600;700;800&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
]

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = e.request.url;
    if (e.request.method !== 'GET') return;
    if (url.startsWith('http') === false) return;
    if (url.includes('/api/')) return;
    if (url.includes('firestore.googleapis') || url.includes('googleapis.com') || url.includes('gstatic.com') || url.includes('paystack.co')) {
        return;
    }
    e.respondWith(
        caches.match(e.request).then(cached => {
            const fetchPromise = fetch(e.request).then(netResponse => {
                if (netResponse && netResponse.ok && netResponse.type === 'basic') {
                    const copy = netResponse.clone();
                    caches.open(CACHE).then(c => c.put(e.request, copy));
                }
                return netResponse;
            }).catch(() => cached);
            return cached || fetchPromise;
        })
    );
});