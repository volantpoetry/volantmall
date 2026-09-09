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
    const photoURL = (userData && (userData.cachedAvatarURL || userData.photoURL)) || currentUser.photoURL || null;
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
        <button class="acct-item" onclick="toggleAccountMenu(); signOutUser();"><i class="fas fa-sign-out-alt"></i> Sign out</button>
        <small class="acct-foot">Signed in on Volant Mall</small>`;
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

function requireAuth(redirect) {
    const target = redirect || location.pathname.split('/').pop() || 'index.html';
    window.location.href = 'login.html?platform=mall&redirect=' + encodeURIComponent(target);
}

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

function getCartItems() {
    try { return JSON.parse(localStorage.getItem(MALL_CART_KEY)) || []; } catch (e) { return []; }
}
function saveCartItems(items) {
    localStorage.setItem(MALL_CART_KEY, JSON.stringify(items));
    localStorage.setItem(MALL_CART_COUNT_KEY, String(items.reduce((s, it) => s + (it.qty || 1), 0)));
    updateCartBadge();
}
function getCartCount() {
    try { return parseInt(localStorage.getItem(MALL_CART_COUNT_KEY) || '0', 10) || 0; } catch (e) { return 0; }
}
function updateCartBadge() {
    const b = document.getElementById('cartCount');
    if (b) b.textContent = getCartCount();
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
            price: Number(product.price) || 0,
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
document.addEventListener('DOMContentLoaded', () => {
    updateCartBadge();
    loadPaystackConfig();
    renderAvatar();
});