// ============================================================
// VOLANT MALL — shared runtime (Firebase init, auth, cart, toasts,
// Paystack config + currency helpers used by every mall page)
// ============================================================

try { if (history.scrollRestoration) history.scrollRestoration = 'manual'; } catch (e) {}
window.scrollTo(0, 0);

const firebaseConfig = {
    apiKey: "AIzaSyC4DHI8aBVY4JjTvJ-r-TGIDPsewtEWxzU",
    authDomain: "silent-depth.firebaseapp.com",
    projectId: "silent-depth",
    storageBucket: "silent-depth.appspot.com"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// ===== CLOUDINARY (uploads — same CDN as the rest of the platform) =====
// Mall store logo/banner + product photos use the 'volant_mall' unsigned
// preset. 'profile_pics' is used ONLY by user profile/avatar uploads.
const CLOUDINARY_CONFIG = {
    cloudName: 'dzoq4pgjn',
    uploadPreset: 'volant_mall',
    folder: 'volant-mall'
};

async function uploadToCloudinary(file) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);
    if (CLOUDINARY_CONFIG.folder) fd.append('folder', CLOUDINARY_CONFIG.folder);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/image/upload`, {
        method: 'POST',
        body: fd
    });
    if (!res.ok) {
        throw new Error('Upload failed (' + res.status + ')');
    }
    const data = await res.json();
    if (!data.secure_url) {
        throw new Error((data.error && data.error.message) || 'Upload failed');
    }
    return data.secure_url;
}

// ===== PAYSTACK =====
const PAYSTACK_API_BASE = 'https://volantmall.vercel.app/api';
const PAYSTACK_PUBLIC_KEY_FALLBACK = 'pk_test_bba6e3bfb9fefff1b6c49aceb34344c8f92b9499';
let PAYSTACK_PUBLIC_KEY = '';

function isDevMode() {
    return location.protocol === 'file:' ||
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1';
}

// ===== THEME (dark mode) =====
function currentTheme() {
    try { return localStorage.getItem('vm_theme') || 'light'; } catch (e) { return 'light'; }
}
function applyTheme() {
    const t = currentTheme();
    document.documentElement.setAttribute('data-theme', t);
    const btns = document.querySelectorAll('[data-theme-btn]');
    btns.forEach(b => {
        const icon = b.querySelector('i') || b.querySelector('.fa-moon, .fa-sun');
        if (icon) {
            icon.className = 'fas ' + (t === 'dark' ? 'fa-sun' : 'fa-moon');
        } else {
            b.innerHTML = t === 'dark' ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
        }
        b.title = t === 'dark' ? 'Light mode' : 'Dark mode';
    });
    const menuTheme = document.querySelector('.nav-links .nav-theme');
    if (menuTheme) {
        menuTheme.innerHTML = t === 'dark'
            ? '<i class="fas fa-sun"></i> Light mode'
            : '<i class="fas fa-moon"></i> Dark mode';
    }
}
function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('vm_theme', next); } catch (e) {}
    applyTheme();
}
// apply early (before paint)
(function () {
    try {
        const t = localStorage.getItem('vm_theme');
        if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    } catch (e) {}
})();
document.addEventListener('DOMContentLoaded', applyTheme);

// Effective shoppable price — a valid salePrice (lower than list) wins.
function effectivePrice(p) {
    if (!p) return 0;
    const base = Number(p.price) || 0;
    const sale = Number(p.salePrice);
    if (Number.isFinite(sale) && sale > 0 && sale < base) return sale;
    return base;
}

// ===== SELL ENTRY =====
// Signed-in sellers go straight to their public store; new sellers go to setup.
function renderSellerSocials(seller) {
    const socials = (seller && seller.socials) || {};
    const hrefs = {
        instagram: v => 'https://instagram.com/' + v.replace(/^@/, ''),
        tiktok: v => 'https://tiktok.com/@' + v.replace(/^@/, ''),
        twitter: v => 'https://x.com/' + v.replace(/^@/, ''),
        whatsapp: v => 'https://wa.me/' + v.replace(/[^0-9]/g, ''),
        facebook: v => /^https?:\/\//i.test(v) ? v : 'https://facebook.com/' + v.replace(/^@/, '')
    };
    const icons = { instagram: 'fa-instagram', tiktok: 'fa-tiktok', twitter: 'fa-x-twitter', whatsapp: 'fa-whatsapp', facebook: 'fa-facebook' };
    const labels = { instagram: 'Instagram', tiktok: 'TikTok', twitter: 'X', whatsapp: 'WhatsApp', facebook: 'Facebook' };
    const items = [];
    Object.keys(hrefs).forEach(k => {
        if (socials[k]) {
            items.push(`<a class="social-link sl-${escapeHtml(k)}" href="${escapeHtml(hrefs[k](socials[k]))}" target="_blank" rel="noopener" aria-label="${labels[k]}"><i class="fab ${icons[k]}"></i> <span>${labels[k]}</span></a>`);
        }
    });
    return items.join('');
}

function goSell(event) {
    if (!currentUser) return true;
    if (event) event.preventDefault();
    db.collection('mall-sellers').doc(currentUser.uid).get()
        .then(snap => {
            location.href = snap.exists
                ? 'store.html?store=' + encodeURIComponent(currentUser.uid)
                : 'submit.html';
        })
        .catch(() => { location.href = 'submit.html'; });
    return false;
}

let _isSeller = false;
function isSeller() { return _isSeller; }

function updateNavSellLinks() {
    const links = document.querySelectorAll('.nav-selllink');
    links.forEach(a => {
        if (_isSeller) {
            a.innerHTML = '<i class="fas fa-chart-line"></i> My Store';
        }
    });
    const heroBtn = document.querySelector('.hero-cta .btn-accent');
    if (heroBtn && _isSeller) {
        heroBtn.innerHTML = '<i class="fas fa-chart-line"></i> Go to My Store';
    }
    const footSell = document.getElementById('footSellLink');
    if (footSell && _isSeller) {
        footSell.textContent = 'My Store';
    }
    const topSellBtn = document.querySelector('.topbar-right .btn-ghost[href="submit.html"]');
    if (topSellBtn && _isSeller) {
        topSellBtn.innerHTML = '<i class="fas fa-chart-line"></i> My Store';
        topSellBtn.href = 'manage.html';
        topSellBtn.onclick = null;
    }
    const heroStoresEmpty = document.querySelector('.empty-state a[href="submit.html"]');
    if (heroStoresEmpty && _isSeller) {
        heroStoresEmpty.href = 'manage.html';
        heroStoresEmpty.textContent = 'Manage your store';
    }
}

async function loadPaystackConfig() {
    try {
        const res = await fetch(PAYSTACK_API_BASE + '/mall-paystack-config');
        const data = await res.json();
        if (data && data.publicKey) PAYSTACK_PUBLIC_KEY = data.publicKey;
    } catch (e) {
        console.warn('Could not load Paystack config:', e);
    }
    if (!PAYSTACK_PUBLIC_KEY) PAYSTACK_PUBLIC_KEY = PAYSTACK_PUBLIC_KEY_FALLBACK;
}

// ===== AUTH =====
let currentUser = null;
let userData = null;

auth.onAuthStateChanged(async (user) => {
    currentUser = user;
    if (user) {
        try {
            const [userSnap, sellerSnap] = await Promise.all([
                db.collection('users').doc(user.uid).get(),
                db.collection('mall-sellers').doc(user.uid).get()
            ]);
            userData = userSnap.exists ? userSnap.data() : null;
            _isSeller = sellerSnap.exists;
        } catch (e) {
            console.warn('Error loading user data:', e);
            userData = null;
            _isSeller = false;
        }
    } else {
        userData = null;
        _isSeller = false;
    }
    renderAvatar();
    updateMobileNavAuth();
    renderNotifBadge();
    updateNavSellLinks();
    if (typeof onAppAuthChange === 'function') onAppAuthChange(user);
});

function renderAvatar() {
    const el = document.getElementById('userBtn');
    const menu = document.getElementById('accountMenu');
    if (!currentUser) {
        if (el) {
            el.classList.add('user-signin');
            el.title = 'Sign in';
            el.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign in';
        }
        if (menu) menu.innerHTML = '';
        return;
    }
    const photoURL = (userData && (userData.photoURL || userData.cachedAvatarURL)) || currentUser.photoURL || null;
    if (el) {
        el.classList.remove('user-signin');
        const displayName = (userData && (userData.username || userData.displayName)) || currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : '') || 'User';
        el.title = currentUser.email || 'Account';
        if (photoURL) {
            el.style.background = '';
            el.innerHTML = `<img src="${escapeHtml(photoURL)}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="avatarImgError(this)">`;
        } else {
            el.innerHTML = `<span style="color:white;font-size:0.75rem;font-weight:700;line-height:1;">${getInitials(displayName)}</span>`;
            el.style.background = colorFromName(displayName);
        }
    }
    if (!menu) return;
    const displayName = (userData && (userData.username || userData.displayName)) || currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : '') || 'User';
    const email = currentUser.email || '';
    menu.innerHTML = `
        <div class="acct-head">
            <div class="acct-pic">${photoURL ? `<img src="${escapeHtml(photoURL)}" alt="" onerror="avatarImgError(this)">` : `<span>${escapeHtml(getInitials(displayName))}</span>`}</div>
            <div class="acct-id">
                <div class="acct-name">${escapeHtml(displayName)}</div>
                ${email ? `<div class="acct-email">${escapeHtml(email)}</div>` : ''}
            </div>
        </div>
        <hr>
        <button class="acct-item" onclick="shareReferral();"><i class="fas fa-gift"></i> Share & earn</button>
        <button class="acct-item" onclick="toggleAccountMenu(); signOutUser();"><i class="fas fa-sign-out-alt"></i> Sign out</button>
        <small class="acct-foot">Signed in on Volant Mall</small>`;
}

function shareReferral() {
    const base = location.origin || 'https://volantmall.vercel.app';
    const url = base + '/index.html' + (currentUser ? '?ref=' + encodeURIComponent(currentUser.uid) : '');
    const text = 'Shop Volant Mall — discover local sellers, fresh products & trusted stores. ' + url;
    try {
        if (navigator.share) { navigator.share({ title: 'Volant Mall', text: text, url: url }).catch(() => {}); toggleAccountMenu(); return; }
    } catch (e) { /* fall through */ }
    if (navigator.clipboard) { navigator.clipboard.writeText(text).catch(() => {}); }
    showToast('Referral link copied — earn when friends order 🎁', 'success');
    toggleAccountMenu();
}

function renderNotifBadge() {
    const bell = document.querySelector('.btn-notif');
    const badge = document.getElementById('notifCount');
    if (!badge) return;
    if (!currentUser) {
        badge.classList.remove('show');
        badge.textContent = '0';
        if (bell) bell.style.display = 'none';
        return;
    }
    if (bell) bell.style.display = '';
    try {
        db.collection('notifications').where('userId', '==', currentUser.uid).where('read', '==', false).onSnapshot((snap) => {
            const count = snap.size;
            badge.textContent = count;
            if (count > 0) badge.classList.add('show');
            else badge.classList.remove('show');
        }, (err) => {
            console.warn('Notif badge error:', err);
        });
    } catch (e) {
        console.warn('Notif badge setup error:', e);
    }
}

function avatarImgError(img) {
    const el = (img && (img.closest('#userBtn') || img.closest('.acct-pic'))) || null;
    if (!el) return;
    if (!currentUser) {
        renderAvatar();
        return;
    }
    const name = (userData && (userData.username || userData.displayName)) || currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : '') || 'U';
    el.innerHTML = `<span style="color:white;font-size:0.75rem;font-weight:700;line-height:1;">${getInitials(name)}</span>`;
    el.style.background = colorFromName(name);
}

let accountMenuWasOpen = false;

function toggleAccountMenu(forceClose) {
    if (!currentUser) { requireAuth(); return; }
    const menu = document.getElementById('accountMenu');
    if (!menu) return;
    if (forceClose || menu.classList.contains('open')) menu.classList.remove('open');
    else menu.classList.add('open');
}

function accountClick() {
    if (currentUser) toggleAccountMenu();
    else requireAuth();
}

document.addEventListener('click', function (e) {
    if (e.target.closest('#userBtnWrap')) return;
    const menu = document.getElementById('accountMenu');
    if (menu && menu.classList.contains('open')) menu.classList.remove('open');
});

// ===== MOBILE NAV (burger menu) =====
function initMobileNav() {
    const toggle = document.getElementById('menuToggle');
    const links = document.getElementById('navLinks');
    if (!toggle || !links) return;
    toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        const open = links.classList.toggle('open');
        toggle.innerHTML = open ? '<i class="fas fa-times"></i>' : '<i class="fas fa-bars"></i>';
    });
    document.addEventListener('click', function (e) {
        if (e.target.closest('#navLinks') || e.target.closest('#menuToggle')) return;
        if (links.classList.contains('open')) {
            links.classList.remove('open');
            toggle.innerHTML = '<i class="fas fa-bars"></i>';
        }
    });
    const signOutLink = document.getElementById('mobileSignOutBtn');
    if (signOutLink) signOutLink.addEventListener('click', function (e) {
        e.preventDefault();
        links.classList.remove('open');
        toggle.innerHTML = '<i class="fas fa-bars"></i>';
        signOutUser();
    });
}

function updateMobileNavAuth() {
    const signInLink = document.getElementById('mobileSignInBtn');
    const signOutLink = document.getElementById('mobileSignOutBtn');
    if (signInLink) {
        signInLink.style.display = 'none';
    }
    if (signOutLink) {
        signOutLink.style.display = currentUser ? '' : 'none';
        if (currentUser) {
            signOutLink.innerHTML = '<i class="fas fa-sign-out-alt"></i> Log Out';
        }
    }
    const sellLink = document.querySelector('.nav-selllink');
    const myStoreLink = document.querySelector('.nav-mystore');
    if (sellLink && myStoreLink) {
        if (currentUser) {
            sellLink.style.display = 'none';
            myStoreLink.style.display = '';
            myStoreLink.href = 'store.html?store=' + encodeURIComponent(currentUser.uid);
        } else {
            sellLink.style.display = '';
            myStoreLink.style.display = 'none';
        }
    }
}

initMobileNav();

function currentPageForRedirect() {
    const page = location.pathname.split('/').pop();
    return './' + (page || 'index.html') + location.search;
}
function requireAuth(redirect) {
    const target = redirect || currentPageForRedirect() || 'index.html';
    window.location.href = 'login.html?platform=mall&redirect=' + encodeURIComponent(target);
}
window.signInHere = function () {
    requireAuth(currentPageForRedirect());
};

function signOutUser() {
    if (auth && auth.signOut) {
        auth.signOut().then(() => {
            showToast('Signed out.', 'info');
            renderAvatar();
        }).catch(e => console.error(e));
    }
}

// ===== TOAST =====
let toastTimeout = null;
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) {
        alert(message);
        return;
    }
    toast.textContent = message;
    toast.style.background = type === 'error' ? '#b76e4b' : (type === 'success' ? '#28a745' : '#4b2aad');
    toast.classList.add('active');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('active'), 4000);
}

// ===== CART (shared across pages) =====
const MALL_CART_KEY = 'volant_mall_cart';
const MALL_CART_COUNT_KEY = 'volant_mall_cart_count';
const MALL_CART_SAVED_AT_KEY = 'volant_mall_cart_saved_at';

function getCartItems() {
    try { return JSON.parse(localStorage.getItem(MALL_CART_KEY)) || []; } catch (e) { return []; }
}
function saveCartItems(items) {
    localStorage.setItem(MALL_CART_KEY, JSON.stringify(items));
    localStorage.setItem(MALL_CART_COUNT_KEY, String(items.reduce((s, it) => s + (it.qty || 1), 0)));
    try { localStorage.setItem(MALL_CART_SAVED_AT_KEY, String(Date.now())); } catch (e) {}
    updateCartBadge();
}
function getCartCount() {
    try { return parseInt(localStorage.getItem(MALL_CART_COUNT_KEY) || '0', 10) || 0; } catch (e) { return 0; }
}
function updateCartBadge() {
    const b = document.getElementById('cartCount');
    if (b) b.textContent = getCartCount();
    const m = document.getElementById('mnavCartCount');
    if (m) m.textContent = getCartCount();
}
function addToCart(product, qty, fulfillment) {
    const items = getCartItems();
    const existing = items.find(it => it.id === product.id && it.fulfillment === fulfillment);
    if (existing) {
        existing.qty = Math.min((existing.qty || 1) + qty, (product.stock || 99));
    } else {
        items.push({
            id: product.id,
            title: product.title,
            price: effectivePrice(product),
            currency: product.currency || 'GHS',
            qty: qty,
            sellerId: product.ownerId,
            sellerName: product.storeName || 'Store',
            sellerSub: product.subaccountCode || '',
            cat: product.category || 'other',
            image: (product.images && product.images[0]) || '',
            fulfillment: fulfillment,
            pickupLocation: product.pickupLocation || '',
            deliveryFee: product.delivery ? (Number(product.deliveryFee) || 0) : 0,
            deliveryRegions: (Array.isArray(product.deliveryRegions) && product.deliveryRegions.length) ? product.deliveryRegions : null,
            allowsPickup: !!product.pickup,
            allowsDelivery: !!product.delivery
        });
    }
    saveCartItems(items);
}
function changeCartQty(id, delta) {
    const items = getCartItems();
    const it = items.find(x => x.id === id);
    if (!it) return;
    it.qty = Math.max(1, Math.min(it.qty + delta, 50));
    saveCartItems(items);
    renderCart && renderCart();
}
function removeCartItem(id) {
    saveCartItems(getCartItems().filter(x => x.id !== id));
    renderCart && renderCart();
}

// ===== HELPERS =====
function ts(t) {
    if (!t) return 0;
    if (t.toMillis) return t.toMillis();
    if (t.seconds) return t.seconds * 1000;
    return 0;
}

function isMobileScreen() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches;
}

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatGHS(n) {
    const v = Number(n) || 0;
    return 'GHS ' + v.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function getInitials(name) {
    if (!name || name === 'Anonymous') return '?';
    const parts = name.trim().split(' ');
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function colorFromName(name) {
    if (!name) return '#4b2aad';
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 50%)`;
}
const MALL_CATEGORIES = [
    { key: 'beauty', label: 'Beauty & Hair' },
    { key: 'fashion', label: 'Fashion (Clothes & Shoes)' },
    { key: 'electronics', label: 'Electronics & Gadgets' },
    { key: 'home', label: 'Home & Kitchen' },
    { key: 'food', label: 'Food & Drinks' },
    { key: 'accessories', label: 'Accessories' },
    { key: 'health', label: 'Health' },
    { key: 'digital', label: 'Digital Products' },
    { key: 'books', label: 'Books & Stationery' },
    { key: 'baby', label: 'Baby & Kids' },
    { key: 'sports', label: 'Sports & Fitness' },
    { key: 'pets', label: 'Pets & Supplies' },
    { key: 'services', label: 'Services' },
    { key: 'groceries', label: 'Groceries' },
    { key: 'other', label: 'Other' }
];

// ===== WISHLIST =====
const MALL_WISHLIST_KEY = 'volant_mall_wishlist';
function getWishlist() {
    try { return JSON.parse(localStorage.getItem(MALL_WISHLIST_KEY)) || []; } catch (e) { return []; }
}
function saveWishlist(list) {
    localStorage.setItem(MALL_WISHLIST_KEY, JSON.stringify(list));
}
function toggleWish(id) {
    const list = getWishlist();
    const on = list.includes(id);
    if (on) saveWishlist(list.filter(x => x !== id));
    else saveWishlist([...list, id]);
    refreshWishButtons();
    return !on;
}
function isWished(id) {
    return getWishlist().includes(id);
}
function refreshWishButtons() {
    document.querySelectorAll('.wish-btn').forEach(btn => {
        const id = btn.getAttribute('data-wish-id');
        if (!id) return;
        const on = isWished(id);
        btn.classList.toggle('on', on);
        btn.title = on ? 'Remove from wishlist' : 'Save to wishlist';
    });
    if (typeof onWishChanged === 'function') {
        try { onWishChanged(); } catch (e) { /* hook is optional */ }
    }
}

// ===== SHARED CUSTOM CATEGORIES =====
const MALL_CUSTOM_CATS_KEY = 'mall-categories';
const MALL_CUSTOM_CATS_DOC = 'store';

async function loadSharedCustomCats() {
    try {
        const snap = await db.collection(MALL_CUSTOM_CATS_KEY).doc(MALL_CUSTOM_CATS_DOC).get();
        const list = (snap.exists && Array.isArray(snap.data().customs)) ? snap.data().customs : [];
        return list.filter(v => typeof v === 'string' && v.trim());
    } catch (e) {
        console.warn('loadSharedCustomCats:', e);
        return [];
    }
}

async function addSharedCustomCat(label) {
    try {
        const ref = db.collection(MALL_CUSTOM_CATS_KEY).doc(MALL_CUSTOM_CATS_DOC);
        await ref.set({ customs: firebase.firestore.FieldValue.arrayUnion(label) }, { merge: true });
        return true;
    } catch (e) {
        console.warn('addSharedCustomCat:', e);
        return false;
    }
}

function titleCaseCat(s) {
    return String(s || '').trim()
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

// ===== SERVICE WORKER (offline shell) =====
if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed:', e));
    });
}

// ===== INIT =====
function injectDrawerTheme() {
    const nav = document.getElementById('navLinks');
    if (!nav) return;
    // On pages with the mobile bottom-nav theme button (Shop/Details/Store/
    // Orders/Alerts) we don't duplicate the toggle inside the drawer.
    if (document.querySelector('.mobile-nav .mnav-theme')) {
        const existing = nav.querySelector('.nav-theme');
        if (existing) existing.remove();
        return;
    }
    if (nav.querySelector('.nav-theme')) return;
    const item = document.createElement('a');
    item.href = '#';
    item.className = 'nav-theme';
    item.style.cursor = 'pointer';
    item.addEventListener('click', (e) => {
        e.preventDefault();
        toggleTheme();
    });
    const signOut = nav.querySelector('#mobileSignOutBtn');
    if (signOut) nav.insertBefore(item, signOut);
    else nav.appendChild(item);
    applyTheme();
}

// Preserve the current page (and its query string) when a guest taps the
// static top-bar / footer "Sign in" links, so after login they land back on
// the same product / store page instead of the home page.
function rewriteSignInLinks() {
    const cur = location.pathname.split('/').pop();
    const skipPages = ['login.html', 'signup.html', 'verify-email.html', 'users-reset.html'];
    if (skipPages.indexOf(cur) >= 0) return;
    const target = encodeURIComponent(currentPageForRedirect());
    document.querySelectorAll('a[href*="login.html?platform=mall"]').forEach(a => {
        if (a.getAttribute('onclick')) return;
        a.href = 'login.html?platform=mall&redirect=' + target;
    });
}

// ===== ABANDONED CART RECOVERY =====
// If a buyer leaves items in the cart for more than ~3 hours, nudge them:
// pop a dismissable banner and (when signed in) file a notifications doc so
// it lands in the bell too. Rate-limited to once every 12 hours per cart.
const MALL_CART_REMIND_KEY = 'volant_mall_cart_reminded_at';
function checkAbandonedCart() {
    try {
        const items = getCartItems();
        if (!items.length) return;
        const savedAt = parseInt(localStorage.getItem(MALL_CART_SAVED_AT_KEY) || '0', 10) || 0;
        if (!savedAt) return;
        const ageMs = Date.now() - savedAt;
        if (ageMs < 3 * 60 * 60 * 1000) return;

        const last = parseInt(localStorage.getItem(MALL_CART_REMIND_KEY) || '0', 10) || 0;
        if (Date.now() - last < 12 * 60 * 60 * 1000) return;
        try { localStorage.setItem(MALL_CART_REMIND_KEY, String(Date.now())); } catch (e) {}

        const qty = items.reduce((s, it) => s + (it.qty || 1), 0);
        const titles = items.slice(0, 2).map(it => it.title || 'item').join(', ');
        const pending = currentUser
            ? db.collection('notifications').add({
                userId: currentUser.uid,
                platform: 'mall',
                type: 'cart_reminder',
                title: 'Your cart is waiting 🛍️',
                body: qty + ' item' + (qty === 1 ? '' : 's') + ' (' + titles + (items.length > 2 ? '…' : '') + ') are still in your bag on Volant Mall.',
                read: false,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(e => console.warn('Cart reminder notif failed:', e))
            : Promise.resolve();

        pending.then(() => {
            if (document.getElementById('cartReminder')) return;
            const div = document.createElement('div');
            div.id = 'cartReminder';
            div.style.cssText = 'position:fixed;bottom:1rem;left:1rem;right:1rem;max-width:430px;z-index:9999;background:#2a2138;color:#fff;border-radius:16px;padding:0.85rem 1rem;display:flex;align-items:center;gap:0.8rem;box-shadow:0 10px 30px rgba(0,0,0,0.35);font-size:0.85rem;';
            div.innerHTML = '<i class="fas fa-shopping-bag" style="font-size:1.2rem;flex-shrink:0;"></i><div style="flex:1;">' + qty + ' item' + (qty === 1 ? '' : 's') + ' still in your cart. <a href="#" style="color:#ffd35c;font-weight:700;text-decoration:underline;" onclick="event.preventDefault();if(window.openCart){openCart();}else{location.href=\'index.html\';}">Finish your order &rarr;</a></div><button onclick="this.parentNode.remove()" style="background:none;border:none;color:#aaa;font-size:1.1rem;cursor:pointer;line-height:1;" aria-label="Dismiss">&times;</button>';
            document.body.appendChild(div);
        }).catch(e => console.warn('Cart reminder banner error:', e));
    } catch (e) {
        console.warn('Abandoned cart check error:', e);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    updateCartBadge();
    loadPaystackConfig();
    checkAbandonedCart();
    renderAvatar();
    injectDrawerTheme();
    rewriteSignInLinks();
});