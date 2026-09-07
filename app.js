// ============================================================
// VOLANT MALL — shared runtime (Firebase init, auth, cart, toasts,
// Paystack config + currency helpers used by every mall page)
// ============================================================

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
            const snap = await db.collection('users').doc(user.uid).get();
            userData = snap.exists ? snap.data() : null;
        } catch (e) {
            console.warn('Error loading user doc:', e);
            userData = null;
        }
    } else {
        userData = null;
    }
    renderAvatar();
    updateMobileNavAuth();
    if (typeof onAppAuthChange === 'function') onAppAuthChange(user);
});

function renderAvatar() {
    const el = document.getElementById('userBtn');
    const menu = document.getElementById('accountMenu');
    if (!currentUser) {
        if (el) {
            el.style.background = 'var(--primary-soft)';
            el.innerHTML = '<i class="fas fa-user" style="font-size:0.95rem;color:var(--primary);"></i>';
            el.title = 'Sign in';
        }
        if (menu) menu.innerHTML = '';
        return;
    }
    const photoURL = (userData && (userData.cachedAvatarURL || userData.photoURL)) || currentUser.photoURL || null;
    if (el) {
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
        signInLink.style.display = currentUser ? 'none' : '';
        if (!currentUser) {
            signInLink.href = 'login.html?platform=mall&redirect=' + encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
        }
    }
    if (signOutLink) signOutLink.style.display = currentUser ? '' : 'none';
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