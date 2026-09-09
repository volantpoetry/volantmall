// ============================================================
// FILE: api/mall-finalize-order.js
// ============================================================
// Volant Mall - server-side order finalisation.
//
// The client creates a mall-checkouts/{reference} document before
// opening Paystack. After a successful charge this endpoint:
//   1. verifies the Firebase ID token
//   2. verifies the Paystack transaction against the secret key
//   3. rebuilds every line item from the ACTUAL Firestore product
//      docs (price, delivery fee, fulfillment availability) so the
//      charged amount must equal the real catalogue total
//   4. atomically checks + decrements stock and writes per-seller
//      mall-orders docs (idempotent via the reference)
//
// The webhook (mall-webhook.js) calls finaliseOrder() with the same
// core so an order is completed even if the buyer closes the tab
// mid-payment.
// ============================================================

const { db, verifyToken } = require('../lib/mall-admin');

function firebaseNow(admin) {
    return admin.firestore.FieldValue.serverTimestamp();
}
function firebaseIncrement(admin, n) {
    return admin.firestore.FieldValue.increment(n);
}

function cleanPhone(p) {
    return String(p || '').replace(/\s+/g, '');
}

// Effective catalogue price: if a salePrice is set and it is a valid lower
// number, the buyer pays the sale price. Flash/sale pricing is enforced
// server-side so no client can undercharge.
function appliedPrice(p) {
    const base = Number(p.price) || 0;
    const sale = Number(p.salePrice);
    if (Number.isFinite(sale) && sale > 0 && sale < base) return sale;
    return base;
}

async function verifyPaystack(reference, email, expectedAmountPaise) {
    const MALL_PAYSTACK_SECRET_KEY = process.env.MALL_PAYSTACK_SECRET_KEY;
    if (!MALL_PAYSTACK_SECRET_KEY) {
        return { ok: false, message: 'Payment service is not configured for Volant Mall.' };
    }
    let res;
    try {
        res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
            headers: { 'Authorization': `Bearer ${MALL_PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return { ok: false, message: 'Could not reach Paystack to verify payment.' };
    }
    if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        console.error('Paystack verify HTTP error:', res.status, errBody);
        return { ok: false, message: 'Paystack verification failed (HTTP ' + res.status + '): ' + (errBody.message || 'unknown error') };
    }
    const body = await res.json();
    const txn = body.data;
    if (!body.status || !txn || txn.status !== 'success') {
        console.error('Paystack verify logical error:', body);
        return { ok: false, message: 'Transaction not successful. Status: ' + ((txn && txn.status) || body.message || 'unknown') };
    }
    if (Number(txn.amount) !== Number(expectedAmountPaise)) {
        return { ok: false, message: 'Amount mismatch between checkout and Paystack.' };
    }
    if (txn.customer && txn.customer.email && email && txn.customer.email.toLowerCase() !== String(email).toLowerCase()) {
        return { ok: false, message: 'Email mismatch.' };
    }
    return { ok: true, txn };
}

// Core finalise routine shared by the HTTP endpoint and the webhook.
// checkout: { items:[{id,qty,fulfillment}], shipping, email }
async function finaliseOrder(adminDb, { reference, checkout }) {
    if (!reference || !checkout || !Array.isArray(checkout.items) || checkout.items.length === 0) {
        return { ok: false, statusCode: 400, message: 'Checkout items are required.' };
    }

    // ---- idempotency: already finalised? ----
    const existingSnap = await adminDb.collection('mall-orders')
        .where('paymentRef', '==', reference).limit(10).get();
    if (!existingSnap.empty) {
        return {
            ok: true,
            statusCode: 200,
            alreadyFinalized: true,
            orderIds: existingSnap.docs.map(d => d.id),
            message: 'Order was already recorded.'
        };
    }

    const requested = checkout.items.map(it => ({
        id: String(it.id || ''),
        qty: Math.max(1, Math.min(Number(it.qty) || 0, 50)),
        fulfillment: it.fulfillment === 'delivery' ? 'delivery' : 'pickup'
    })).filter(it => it.id && it.qty > 0);

    if (requested.length === 0) return { ok: false, statusCode: 400, message: 'No valid items in checkout.' };

    const prodRefs = requested.map(it => adminDb.collection('mall-products').doc(it.id));
    const prodSnap = await adminDb.getAll(...prodRefs);

    const resolved = [];
    const sellerIds = new Set();
    for (let i = 0; i < requested.length; i++) {
        const req = requested[i];
        const snap = prodSnap[i];
        if (!snap || !snap.exists) return { ok: false, statusCode: 400, message: 'A product in your cart no longer exists.' };
        const p = snap.data();
        if (p.status !== 'active' && p.status !== 'stockout') return { ok: false, statusCode: 400, message: 'A product in your cart is no longer for sale.' };
        sellerIds.add(p.ownerId);

        const deliveryAllowed = !!p.delivery;
        const pickupAllowed = !!p.pickup;
        let fulfillment = req.fulfillment;
        if (fulfillment === 'delivery' && !deliveryAllowed) {
            if (pickupAllowed) fulfillment = 'pickup';
            else return { ok: false, statusCode: 400, message: 'A product in your cart does not offer delivery.' };
        }
        if (fulfillment === 'pickup' && !pickupAllowed) return { ok: false, statusCode: 400, message: 'A product in your cart does not offer pickup.' };

        resolved.push({
            productId: snap.id,
            title: String(p.title || 'Product'),
            price: appliedPrice(p),
            currency: p.currency || 'GHS',
            qty: req.qty,
            image: (p.images && p.images[0]) || '',
            fulfillment: fulfillment,
            deliveryFee: fulfillment === 'delivery' ? (Number(p.deliveryFee) || 0) : 0,
            pickupLocation: (p.pickupLocation || '').trim(),
            ownerId: p.ownerId,
            sellerSub: p.subaccountCode || ''
        });
    }

    // ---- sellers must have payout subaccounts ----
    const sellerDocSnaps = await adminDb.getAll(
        ...[...sellerIds].map(id => adminDb.collection('mall-sellers').doc(id))
    );
    const sellerMeta = {};
    let missingPayout = false;
    [...sellerIds].forEach((id, i) => {
        const s = sellerDocSnaps[i].data ? sellerDocSnaps[i].data() : null;
        if (!s || !s.subaccountCode) { missingPayout = true; return; }
        sellerMeta[id] = { storeName: s.storeName || 'Store', subaccount: s.subaccountCode };
    });
    if (missingPayout) {
        return { ok: false, statusCode: 409, message: 'A seller has not set up payouts. Please contact support.' };
    }

    // ---- compute true totals from catalogue ----
    const sellerItems = {};
    for (const it of resolved) {
        if (!sellerItems[it.ownerId]) sellerItems[it.ownerId] = [];
        sellerItems[it.ownerId].push(it);
    }
    let expectedPaise = 0;
    const perSeller = {};
    for (const sId of Object.keys(sellerItems)) {
        const items = sellerItems[sId];
        let total = 0;
        for (const it of items) total += (it.price * it.qty) + it.deliveryFee;
        perSeller[sId] = { items, amount: total };
        expectedPaise += Math.round(total * 100);
    }

    // ---- verify with Paystack (expected = catalogue total) ----
    const checkoutEmail = String(checkout.email || '');
    const verify = await verifyPaystack(reference, checkoutEmail, expectedPaise);
    if (!verify.ok) {
        return { ok: false, statusCode: 400, message: verify.message };
    }

    const shipping = checkout.shipping && Object.keys(checkout.shipping).length ? checkout.shipping : null;
    const userId = checkout.uid;

    // ---- atomic finalise: stock check + decrement + orders + notifications ----
    const admin = require('firebase-admin');
    const run = async (transaction) => {
        const tProdSnap = await transaction.getAll(...prodRefs);
        const stockDeltas = [];
        for (let i = 0; i < requested.length; i++) {
            const snap = tProdSnap[i];
            if (!snap.exists) throw new Error('A product in your cart no longer exists.');
            const p = snap.data();
            if (Number(p.stock || 0) < requested[i].qty) {
                throw new Error('Not enough stock for "' + (p.title || 'item') + '".');
            }
            stockDeltas.push({ doc: snap.ref, qty: requested[i].qty });
        }

        const orderIds = [];
        for (const sId of Object.keys(perSeller)) {
            const meta = sellerMeta[sId];
            const orderRef = adminDb.collection('mall-orders').doc();
            const lineItems = perSeller[sId].items.map(it => ({
                productId: it.productId,
                title: it.title,
                price: it.price,
                currency: it.currency,
                qty: it.qty,
                image: it.image,
                fulfillment: it.fulfillment,
                deliveryFee: it.deliveryFee,
                pickupLocation: it.pickupLocation || ''
            }));
            transaction.set(orderRef, {
                userId: userId,
                sellerId: sId,
                sellerName: meta.storeName,
                items: lineItems,
                shipping: shipping,
                platform: 'mall',
                ref: reference + '_' + sId.slice(0, 6),
                paymentRef: reference,
                amount: perSeller[sId].amount,
                userPhone: (shipping && cleanPhone(shipping.phone)) || checkout.phone || checkout.email || '',
                paymentStatus: 'paid',
                orderStatus: 'processing',
                trace: [{ status: 'paid', at: admin.firestore.Timestamp.now(), note: 'Payment received and order placed.' }],
                purchasedAt: firebaseNow(admin)
            });
            orderIds.push(orderRef.id);

            transaction.set(adminDb.collection('notifications').doc(), {
                userId: sId,
                type: 'new_order',
                title: 'New order received 🎉',
                body: 'Someone bought ' + lineItems.length + ' item(s) from ' + meta.storeName + '. Check your orders tab.',
                orderId: orderRef.id,
                ref: reference,
                read: false,
                createdAt: firebaseNow(admin)
            });
        }

        for (const d of stockDeltas) {
            transaction.update(d.doc, {
                stock: firebaseIncrement(admin, -d.qty),
                saleCount: firebaseIncrement(admin, d.qty)
            });
        }

        transaction.update(
            adminDb.collection('mall-checkouts').doc(reference),
            { status: 'finalized', finalizedAt: firebaseNow(admin) }
        );

        return orderIds;
    };

    let orderIds;
    try {
        orderIds = await adminDb.runTransaction(run);
    } catch (e) {
        console.error('Finalise transaction error:', e);
        return {
            ok: false,
            statusCode: 409,
            message: e.message || 'Could not complete your order. Your payment is safe - contact support with reference ' + reference
        };
    }

    // ---- referral: notify the referrer on their friend's FIRST order ----
    try {
        await rewardReferrer(adminDb, userId, reference, expectedPaise);
    } catch (e) {
        console.warn('Referral notify error:', e);
    }

    return { ok: true, statusCode: 200, orderIds, reference, amount: expectedPaise / 100, message: 'Order confirmed.' };
}

// Best-effort: when a buyer who arrived via ?ref= completes their first
// order, send the referrer a notification (potential affiliate/credit hook
// for the future).
async function rewardReferrer(adminDb, userId, reference, amountPaise) {
    if (!userId) return;
    const userRef = adminDb.collection('users').doc(userId);
    const userSnap = await userRef.get();
    let refUid = '';
    if (userSnap.exists) refUid = (userSnap.data().referredBy || '').trim();
    if (!refUid || refUid === userId) return;

    const previousOrders = await adminDb.collection('mall-orders')
        .where('userId', '==', userId).limit(1).get();
    if (!previousOrders.empty) return; // not their first order

    await adminDb.collection('notifications').add({
        userId: refUid,
        type: 'referral',
        title: 'Your referral made a purchase 🎁',
        body: 'Someone you invited placed their first order on Volant Mall (' + (Number(amountPaise) || 0) / 100 + ' GHS). Rewards are on the way!',
        ref: reference,
        read: false,
        createdAt: firebaseNow(require('firebase-admin'))
    });
}

// ===== HTTP handler =====
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed. Use POST.' });
    }

    // Always respond with JSON so the browser callback never hangs on a
    // killed/crashed invocation (that surfaces as "Failed to fetch").
    try {
        const { reference, idToken, checkout } = req.body || {};
        console.log('[FINALIZE] Request received — reference:', reference, '| has idToken:', !!idToken, '| has checkout body:', !!checkout);

        if (!reference) {
            console.error('[FINALIZE] No reference provided.');
            return res.status(400).json({ success: false, message: 'Reference is required.' });
        }

        let decoded;
        try {
            decoded = await verifyToken(idToken);
            console.log('[FINALIZE] Auth OK — uid:', decoded.uid);
        } catch (e) {
            console.error('[FINALIZE] Auth failed:', e.message);
            return res.status(401).json({ success: false, message: 'Authentication failed.' });
        }

        const hasSecret = !!process.env.MALL_PAYSTACK_SECRET_KEY;
        console.log('[FINALIZE] MALL_PAYSTACK_SECRET_KEY set:', hasSecret, '| key prefix:', hasSecret ? process.env.MALL_PAYSTACK_SECRET_KEY.substring(0, 7) + '...' : 'NONE');

        const adminDb = db();
        const checkoutDoc = await adminDb.collection('mall-checkouts').doc(reference).get();
        if (!checkoutDoc.exists) {
            console.error('[FINALIZE] Checkout doc NOT FOUND for ref:', reference);
            return res.status(400).json({ success: false, message: 'Checkout session not found for this reference.' });
        }
        const cd = checkoutDoc.data();
        console.log('[FINALIZE] Checkout doc found — status:', cd.status, '| items:', (cd.items || []).length, '| email:', cd.email);

        const result = await finaliseOrder(adminDb, {
            reference,
            checkout: {
                items: (checkout && checkout.items) || (cd.items || []),
                shipping: (checkout && checkout.shipping) || cd.shipping || null,
                email: (checkout && checkout.email) || (cd.email || ''),
                phone: cd.phone || '',
                uid: decoded.uid
            }
        });

        console.log('[FINALIZE] Result:', result.ok ? 'SUCCESS' : 'FAILED', '| status:', result.statusCode, '| message:', result.message);
        return res.status(result.statusCode || 500).json({
            success: result.ok,
            alreadyFinalized: result.alreadyFinalized || false,
            orderIds: result.orderIds || [],
            reference: result.reference || reference,
            amount: result.amount || null,
            message: result.message || ''
        });
    } catch (err) {
        console.error('[FINALIZE] UNCAUGHT handler error:', err);
        return res.status(500).json({
            success: false,
            message: 'Order could not be confirmed right now. Your payment is safe - the webhook will finalise it.'
        });
    }
};

module.exports.finaliseOrder = finaliseOrder;
module.exports.firebaseNow = firebaseNow;
module.exports.firebaseIncrement = firebaseIncrement;