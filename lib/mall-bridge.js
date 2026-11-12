// ============================================================
// FILE: lib/mall-bridge.js
// ============================================================
// Trusted bridge between Aerofindex and Volant Plaza.
//
// Aerofindex calls /api/mall-bridge with a shared secret to publish
// products and push stock changes. Plaza sends paid orders back to
// Aerofindex with an HMAC-signed webhook so the B2B ledger can record
// revenue, Paystack fees and stock movements.
// ============================================================

const crypto = require('crypto');
const { db } = require('./mall-admin');

const SOURCE = 'aerofindex';
const EVENT_COLLECTION = 'mall-bridge-events';

function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySecret(req) {
    const expected = process.env.PLAZA_BRIDGE_SECRET || '';
    if (!expected) return false;
    return safeEqual(req.headers['x-plaza-bridge-secret'], expected);
}

function bridgeRef(workspaceId, productId) {
    return `${asString(workspaceId)}:${asString(productId)}`;
}

function normaliseImages(images) {
    if (!Array.isArray(images)) return [];
    const seen = new Set();
    const clean = [];
    for (const value of images) {
        const url = asString(value).trim();
        if (!/^https?:\/\//i.test(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        clean.push(url.slice(0, 1000));
        if (clean.length >= 8) break;
    }
    return clean;
}

const CATEGORY_MAP = {
    'beauty': 'beauty',
    'beauty & hair': 'beauty',
    'fashion': 'fashion',
    'fashion (clothes & shoes)': 'fashion',
    'electronics': 'electronics',
    'electronics & gadgets': 'electronics',
    'home': 'home',
    'home & kitchen': 'home',
    'household': 'home',
    'hardware': 'home',
    'food': 'food',
    'food & drinks': 'food',
    'beverages': 'food',
    'bakery': 'food',
    'snacks': 'food',
    'accessories': 'accessories',
    'health': 'health',
    'personal care': 'health',
    'digital': 'digital',
    'digital products': 'digital',
    'books': 'books',
    'books & stationery': 'books',
    'baby': 'baby',
    'baby & kids': 'baby',
    'sports': 'sports',
    'sports & fitness': 'sports',
    'pets': 'pets',
    'pets & supplies': 'pets',
    'services': 'services',
    'groceries': 'groceries',
    'produce': 'groceries',
    'meat & fish': 'groceries',
    'other': 'other'
};

function plazaCategory(raw) {
    const value = asString(raw).trim().toLowerCase();
    if (!value) return 'other';
    return CATEGORY_MAP[value] || (Object.prototype.hasOwnProperty.call(CATEGORY_MAP, value) ? CATEGORY_MAP[value] : 'other');
}

function categoryLabel(key) {
    const labels = {
        beauty: 'Beauty & Hair',
        fashion: 'Fashion (Clothes & Shoes)',
        electronics: 'Electronics & Gadgets',
        home: 'Home & Kitchen',
        food: 'Food & Drinks',
        accessories: 'Accessories',
        health: 'Health',
        digital: 'Digital Products',
        books: 'Books & Stationery',
        baby: 'Baby & Kids',
        sports: 'Sports & Fitness',
        pets: 'Pets & Supplies',
        services: 'Services',
        groceries: 'Groceries',
        other: 'Other'
    };
    return labels[key] || 'Other';
}

async function findListing(adminDb, ref) {
    const snap = await adminDb
        .collection('mall-products')
        .where('bridgeRef', '==', ref)
        .limit(1)
        .get();
    return snap.empty ? null : snap.docs[0];
}

async function resolveSeller(adminDb, sellerUid, sellerEmail) {
    if (sellerUid) {
        const snap = await adminDb.collection('mall-sellers').doc(String(sellerUid)).get();
        if (!snap.exists) return { error: 'No Volant Plaza store was found for that seller account.' };
        return { id: snap.id, data: snap.data() };
    }

    const email = asString(sellerEmail).trim().toLowerCase();
    if (!email) {
        return { error: 'Set the Volant Plaza seller email in Aerofindex Settings, or provide sellerUid.' };
    }

    let snap = await adminDb
        .collection('mall-sellers')
        .where('contactEmail', '==', email)
        .limit(1)
        .get();
    if (snap.empty) {
        snap = await adminDb
            .collection('mall-sellers')
            .where('email', '==', email)
            .limit(1)
            .get();
    }
    if (snap.empty) {
        return { error: `No Volant Plaza store is registered for ${email}. Open a Plaza store with that email first.` };
    }
    return { id: snap.docs[0].id, data: snap.docs[0].data() };
}

async function upsertProduct(adminDb, payload) {
    const workspaceId = asString(payload.bridgeWorkspaceId).trim();
    const productId = asString(payload.bridgeProductId).trim();
    if (!workspaceId || !productId) {
        return { ok: false, statusCode: 400, message: 'bridgeWorkspaceId and bridgeProductId are required.' };
    }

    const title = asString(payload.title).trim().slice(0, 160);
    if (!title) return { ok: false, statusCode: 400, message: 'Product title is required.' };

    const price = asNumber(payload.price);
    if (price <= 0) return { ok: false, statusCode: 400, message: 'Set a selling price above zero before listing on Volant Plaza.' };

    const ref = bridgeRef(workspaceId, productId);
    const existingDoc = await findListing(adminDb, ref);

    let seller = null;
    if (!existingDoc) {
        seller = await resolveSeller(adminDb, payload.sellerUid, payload.sellerEmail);
        if (seller.error) return { ok: false, statusCode: 409, message: seller.error };
    }

    const cleanCategory = plazaCategory(payload.category);
    const cleanImages = normaliseImages(payload.images);
    const stock = Math.max(0, Math.floor(asNumber(payload.stock)));
    const now = require('firebase-admin').firestore.FieldValue.serverTimestamp();
    const existing = existingDoc ? existingDoc.data() : {};
    const images = Array.isArray(payload.images)
        ? cleanImages
        : (Array.isArray(existing.images) ? existing.images : []);

    const data = {
        title,
        price,
        currency: 'GHS',
        category: cleanCategory,
        categories: [cleanCategory],
        customCategory: '',
        tags: [categoryLabel(cleanCategory)],
        description: asString(payload.description).slice(0, 5000),
        stock,
        status: stock > 0 ? 'active' : 'stockout',
        images,
        hasImages: images.length > 0,
        updatedAt: now,
        bridgeSource: SOURCE,
        bridgeRef: ref,
        bridgeWorkspaceId: workspaceId,
        bridgeProductId: productId,
        bridgeSyncedAt: now
    };

    if (existingDoc) {
        await existingDoc.ref.set(data, { merge: true });
        return { ok: true, statusCode: 200, id: existingDoc.id, bridgeRef: ref };
    }

    const sellerData = seller ? seller.data : {};
    const newRef = adminDb.collection('mall-products').doc();
    await newRef.set({
        ...data,
        ownerId: seller.id,
        storeName: sellerData.storeName || 'Store',
        storeHandle: sellerData.storeHandle || '',
        pickup: true,
        pickupLocation: asString(sellerData.location).trim() || 'At the store',
        delivery: false,
        deliveryFee: 0,
        deliveryRegions: [],
        saleCount: 0,
        featured: false,
        createdAt: now
    });

    return { ok: true, statusCode: 201, id: newRef.id, bridgeRef: ref };
}

async function patchStock(adminDb, payload) {
    const workspaceId = asString(payload.bridgeWorkspaceId).trim();
    const productId = asString(payload.bridgeProductId).trim();
    if (!workspaceId || !productId) {
        return { ok: false, statusCode: 400, message: 'bridgeWorkspaceId and bridgeProductId are required.' };
    }

    const ref = bridgeRef(workspaceId, productId);
    const existingDoc = await findListing(adminDb, ref);
    if (!existingDoc) {
        return { ok: false, statusCode: 404, message: 'This product is not listed on Volant Plaza yet.' };
    }

    const stock = Math.max(0, Math.floor(asNumber(payload.stock)));
    await existingDoc.ref.set({
        stock,
        status: stock > 0 ? 'active' : 'stockout',
        updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        bridgeSyncedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return { ok: true, statusCode: 200, id: existingDoc.id };
}

async function unpublishProduct(adminDb, payload) {
    const ref = bridgeRef(payload.bridgeWorkspaceId, payload.bridgeProductId);
    const existingDoc = await findListing(adminDb, ref);
    if (!existingDoc) return { ok: true, statusCode: 200, id: null };
    await existingDoc.ref.set({
        status: 'deleted',
        deletedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        bridgeRemovedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: true, statusCode: 200, id: existingDoc.id };
}

function timestampIso(value) {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
    return null;
}

function mapProduct(doc) {
    const p = doc.data() || {};
    return {
        id: doc.id,
        title: asString(p.title),
        description: asString(p.description),
        price: asNumber(p.price),
        salePrice: asNumber(p.salePrice),
        currency: asString(p.currency, 'GHS'),
        category: asString(p.category, 'other'),
        categories: Array.isArray(p.categories) ? p.categories : [],
        customCategory: asString(p.customCategory),
        stock: asNumber(p.stock),
        status: asString(p.status, 'active'),
        images: Array.isArray(p.images) ? p.images : [],
        ownerId: asString(p.ownerId),
        storeName: asString(p.storeName),
        storeHandle: asString(p.storeHandle),
        featured: p.featured === true,
        bridgeRef: asString(p.bridgeRef) || null,
        bridgeWorkspaceId: asString(p.bridgeWorkspaceId) || null,
        bridgeProductId: asString(p.bridgeProductId) || null,
        createdAt: timestampIso(p.createdAt),
        updatedAt: timestampIso(p.updatedAt)
    };
}

async function listProducts(adminDb, payload) {
    const limit = Math.max(1, Math.min(200, Math.floor(asNumber(payload.limit, 50))));
    const sellerUid = asString(payload.sellerUid).trim();
    const includeBridged = payload.includeBridged === true;
    const includeDeleted = payload.includeDeleted === true;
    const ids = Array.isArray(payload.ids)
        ? payload.ids.map(id => asString(id).trim()).filter(Boolean).slice(0, 200)
        : [];

    let docs = [];

    if (ids.length) {
        const snaps = await Promise.all(ids.map(id => adminDb.collection('mall-products').doc(id).get()));
        docs = snaps.filter(snap => snap.exists);
    } else if (sellerUid) {
        const snap = await adminDb
            .collection('mall-products')
            .where('ownerId', '==', sellerUid)
            .limit(limit)
            .get();
        docs = snap.docs;
    } else {
        const snap = await adminDb
            .collection('mall-products')
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();
        docs = snap.docs;
    }

    const products = docs
        .map(mapProduct)
        .filter(p => includeBridged || !p.bridgeRef)
        .filter(p => includeDeleted || p.status !== 'deleted');

    return {
        ok: true,
        statusCode: 200,
        count: products.length,
        products
    };
}

async function getProduct(adminDb, payload) {
    const id = asString(payload.id || payload.productId).trim();
    if (!id) return { ok: false, statusCode: 400, message: 'Product id is required.' };
    const snap = await adminDb.collection('mall-products').doc(id).get();
    if (!snap.exists) return { ok: false, statusCode: 404, message: 'Product not found.' };
    return { ok: true, statusCode: 200, product: mapProduct(snap) };
}

function eventId(reference) {
    return asString(reference).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120) || `event_${Date.now()}`;
}

function orderPayload(doc) {
    const order = doc.data();
    const items = (Array.isArray(order.items) ? order.items : [])
        .filter(item => asString(item.bridgeWorkspaceId) && asString(item.bridgeProductId))
        .map(item => ({
            productId: asString(item.bridgeProductId),
            title: asString(item.title, 'Item'),
            qty: Math.max(0, asNumber(item.qty)),
            price: asNumber(item.price),
            bridgeWorkspaceId: asString(item.bridgeWorkspaceId),
            bridgeProductId: asString(item.bridgeProductId)
        }));
    if (!items.length) return null;
    return {
        orderId: doc.id,
        reference: asString(order.ref),
        sellerId: asString(order.sellerId),
        amount: asNumber(order.amount),
        currency: 'GHS',
        buyerEmail: asString(order.shipping && order.shipping.email) || '',
        buyerPhone: asString(order.userPhone) || asString(order.shipping && order.shipping.phone) || '',
        buyerName: asString(order.shipping && order.shipping.name) || '',
        items
    };
}

async function sendEvent(adminDb, eventDoc) {
    const data = eventDoc.data();
    const url = process.env.AEROFINDEX_BRIDGE_URL || '';
    const secret = process.env.PLAZA_BRIDGE_SECRET || '';
    if (!url || !secret) {
        await eventDoc.ref.set({ status: 'pending', lastError: 'AEROFINDEX_BRIDGE_URL or PLAZA_BRIDGE_SECRET is not configured.' }, { merge: true });
        return false;
    }

    const raw = JSON.stringify(data.payload);
    const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-plaza-signature': signature,
                'x-plaza-event': asString(data.payload && data.payload.event)
            },
            body: raw
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Aerofindex replied ${res.status}: ${text.slice(0, 300)}`);
        }
        await eventDoc.ref.set({
            status: 'sent',
            sentAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
            lastError: null
        }, { merge: true });
        return true;
    } catch (error) {
        await eventDoc.ref.set({
            status: 'failed',
            retries: require('firebase-admin').firestore.FieldValue.increment(1),
            lastError: String(error && error.message || error).slice(0, 500),
            nextAttemptAt: require('firebase-admin').firestore.Timestamp.fromMillis(Date.now() + 5 * 60 * 1000)
        }, { merge: true });
        console.error('Plaza -> Aerofindex forward failed:', error);
        return false;
    }
}

async function forwardPaidOrders(reference, txn) {
    if (!reference) return { forwarded: 0 };
    const adminDb = db();
    const snap = await adminDb
        .collection('mall-orders')
        .where('paymentRef', '==', reference)
        .get();
    const orders = snap.docs.map(orderPayload).filter(Boolean);
    if (!orders.length) return { forwarded: 0 };

    const id = eventId(reference);
    const eventRef = adminDb.collection(EVENT_COLLECTION).doc(id);
    const existing = await eventRef.get();
    if (existing.exists && existing.get('status') === 'sent') {
        return { forwarded: 0, alreadySent: true };
    }

    const payload = {
        event: 'plaza.order.paid',
        reference,
        paidAt: new Date().toISOString(),
        fees: Math.max(0, asNumber(txn && txn.fees) / 100),
        orders
    };

    await eventRef.set({
        reference,
        payload,
        status: 'pending',
        createdAt: existing.exists ? existing.get('createdAt') : require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const sent = await sendEvent(adminDb, eventRef);
    return { forwarded: sent ? orders.length : 0, queued: !sent };
}

async function retryPendingEvents(limit = 10) {
    const adminDb = db();
    const snap = await adminDb
        .collection(EVENT_COLLECTION)
        .where('status', 'in', ['pending', 'failed'])
        .limit(Math.max(1, Math.min(limit, 50)))
        .get();
    let sent = 0;
    for (const doc of snap.docs) {
        const next = doc.get('nextAttemptAt');
        const nextMs = next && typeof next.toMillis === 'function' ? next.toMillis() : 0;
        if (nextMs && nextMs > Date.now()) continue;
        if (await sendEvent(adminDb, doc)) sent += 1;
    }
    return sent;
}

module.exports = {
    verifySecret,
    upsertProduct,
    patchStock,
    unpublishProduct,
    listProducts,
    getProduct,
    forwardPaidOrders,
    retryPendingEvents
};