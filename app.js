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
const storage = typeof firebase.storage === 'function' ? firebase.storage() : null;

// ===== PAYSTACK =====
const PAYSTACK_API_BASE = 'https://volantpoetry.vercel.app/api';
const PAYSTACK_PUBLIC_KEY_FALLBACK = 'pk_test_bba6e3bfb9fefff1b6c49aceb34344c8f92b9499';
let PAYSTACK_PUBLIC_KEY = '';

function isDevMode() {
    return location.protocol === 'file:' ||
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1';
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
    if (typeof onAppAuthChange === 'function') onAppAuthChange(user);
});

function renderAvatar() {
    const el = document.getElementById('userBtn');
    if (!el) return;
    if (currentUser) {
        const displayName = (userData && (userData.username || userData.displayName)) || currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : '') || 'User';
        const photoURL = (userData && (userData.cachedAvatarURL || userData.photoURL)) || null;
        el.title = currentUser.email || 'Account';
        if (photoURL) {
            el.style.backgroundImage = `url(${photoURL})`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.innerHTML = '';
        } else {
            el.style.backgroundImage = 'none';
            el.style.background = colorFromName(displayName);
            el.innerHTML = `<span style="color:white;font-size:0.75rem;font-weight:700;line-height:1;">${getInitials(displayName)}</span>`;
        }
    } else {
        el.style.backgroundImage = 'none';
        el.style.background = '';
        el.innerHTML = `<i class="fas fa-sign-in-alt"></i>`;
        el.title = 'Sign in';
    }
}

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

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    updateCartBadge();
    loadPaystackConfig();
    renderAvatar();
});