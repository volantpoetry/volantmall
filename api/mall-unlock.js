// ============================================================
// FILE: api/mall-unlock.js
// ============================================================
// Volant Mall - one-time payment unlocks ("as pros do").
//
// Sellers can make a single one-time Paystack charge to unlock a
// lasting benefit instead of a recurring subscription:
//   type = 'pro'     -> mall-sellers/{uid}.proStore = true (30 days)
//   type = 'feature' -> mall-products/{productId}.featured = true (30 days)
//
// The server verifies the Firebase ID token, verifies the Paystack
// reference AND the exact expected amount, then applies the flag
// idempotently (mall-unlocks/{reference} guards re-runs). No client
// can unlock something without actually paying for it.
// ============================================================

const { db, verifyToken } = require('../lib/mall-admin');

// GHS prices paid in Paystack (kobo => paise)
const UNLOCK_PLANS = {
    pro:     { amountGHS: 50,  label: 'Pro Store (30 days)',  durationDays: 30 },
    feature: { amountGHS: 15,  label: 'Featured listing (30 days)', durationDays: 30 }
};

function firebaseNow(admin) {
    return admin.firestore.FieldValue.serverTimestamp();
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
        return { ok: false, message: 'Transaction not successful. Status: ' + ((txn && txn.status) || body.message || 'unknown') };
    }
    if (Number(txn.amount) !== Number(expectedAmountPaise)) {
        return { ok: false, message: 'Amount mismatch between unlock and Paystack.' };
    }
    if (txn.customer && txn.customer.email && email && txn.customer.email.toLowerCase() !== String(email).toLowerCase()) {
        return { ok: false, message: 'Email mismatch.' };
    }
    return { ok: true, txn };
}

async function applyUnlock(adminDb, { uid, reference, type, productId }) {
    const plan = UNLOCK_PLANS[type];
    if (!plan) return { ok: false, statusCode: 400, message: 'Unknown unlock type.' };

    // ---- idempotency: already unlocked with this reference? ----
    const existing = await adminDb.collection('mall-unlocks').doc(reference).get();
    if (existing.exists) {
        return { ok: true, statusCode: 200, alreadyApplied: true, message: 'Unlock was already applied.' };
    }

    const admin = require('firebase-admin');
    const expiredAt = admin.firestore.Timestamp.fromMillis(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);

    if (type === 'pro') {
        const sellerRef = adminDb.collection('mall-sellers').doc(uid);
        const sellerSnap = await sellerRef.get();
        if (!sellerSnap.exists) {
            return { ok: false, statusCode: 400, message: 'No seller store found for this account.' };
        }
        const seller = sellerSnap.data();
        if (seller.owner && seller.owner !== uid) {
            return { ok: false, statusCode: 403, message: 'This store belongs to another account.' };
        }
        await adminDb.runTransaction(async (tx) => {
            tx.update(sellerRef, {
                proStore: true,
                proStoreUntil: expiredAt,
                proStorePurchasedAt: firebaseNow(admin)
            });
            tx.set(adminDb.collection('mall-unlocks').doc(reference), {
                type: 'pro',
                uid: uid,
                amountGHS: plan.amountGHS,
                ref: reference,
                createdAt: firebaseNow(admin)
            });
        });
        txNotify(adminDb, uid, 'Pro Store unlocked 🌟', 'Your store now shows the Pro badge for ' + plan.durationDays + ' days. Enjoy the spotlight!', reference, 'mall-unlock');
        return { ok: true, statusCode: 200, message: 'Pro Store unlocked for ' + plan.durationDays + ' days ✓', expiresAt: expiredAt.toDate().toISOString() };
    }

    if (type === 'feature') {
        if (!productId) return { ok: false, statusCode: 400, message: 'Product is required for a feature unlock.' };
        const prodRef = adminDb.collection('mall-products').doc(String(productId));
        const prodSnap = await prodRef.get();
        if (!prodSnap.exists) return { ok: false, statusCode: 400, message: 'Product not found.' };
        const p = prodSnap.data();
        if (p.ownerId !== uid) return { ok: false, statusCode: 403, message: 'You can only feature your own product.' };
        await adminDb.runTransaction(async (tx) => {
            tx.update(prodRef, {
                featured: true,
                featuredUntil: expiredAt,
                featuredPurchasedAt: firebaseNow(admin)
            });
            tx.set(adminDb.collection('mall-unlocks').doc(reference), {
                type: 'feature',
                uid: uid,
                productId: String(productId),
                amountGHS: plan.amountGHS,
                ref: reference,
                createdAt: firebaseNow(admin)
            });
        });
        txNotify(adminDb, uid, 'Listing is featured ⭐', 'Your product is now featured on the homepage for ' + plan.durationDays + ' days.', reference, 'mall-unlock');
        return { ok: true, statusCode: 200, message: 'Product featured for ' + plan.durationDays + ' days ✓', expiresAt: expiredAt.toDate().toISOString() };
    }

    return { ok: false, statusCode: 400, message: 'Unknown unlock type.' };
}

function txNotify(adminDb, uid, title, body, ref, type) {
    adminDb.collection('notifications').add({
        userId: uid,
        platform: 'mall',
        type: type || 'unlock',
        title: title,
        body: body,
        ref: ref || '',
        read: false,
        createdAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    }).catch((e) => console.warn('Unlock notification failed:', e));
}

// ===== HTTP handler =====
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed. Use POST.' });
    }

    try {
        const { reference, idToken, type, productId } = req.body || {};
        if (!reference) return res.status(400).json({ success: false, message: 'Reference is required.' });
        if (!type) return res.status(400).json({ success: false, message: 'Unlock type is required.' });

        const plan = UNLOCK_PLANS[type];
        if (!plan) return res.status(400).json({ success: false, message: 'Unknown unlock type.' });

        let decoded;
        try {
            decoded = await verifyToken(idToken);
        } catch (e) {
            return res.status(401).json({ success: false, message: 'Authentication failed.' });
        }

        const adminDb = db();
        const userSnap = await adminDb.collection('users').doc(decoded.uid).get();
        const email = (userSnap.exists && userSnap.data().email) || '';
        const verify = await verifyPaystack(reference, email, Math.round(plan.amountGHS * 100));
        if (!verify.ok) {
            return res.status(400).json({ success: false, message: verify.message });
        }

        const result = await applyUnlock(adminDb, {
            uid: decoded.uid,
            reference,
            type,
            productId
        });

        return res.status(result.statusCode || 500).json({
            success: result.ok,
            alreadyApplied: result.alreadyApplied || false,
            message: result.message || '',
            expiresAt: result.expiresAt || null
        });
    } catch (err) {
        console.error('[UNLOCK] Uncaught handler error:', err);
        return res.status(500).json({
            success: false,
            message: 'Unlock could not be applied right now. Keep your reference and try again.'
        });
    }
};

module.exports.applyUnlock = applyUnlock;
module.exports.UNLOCK_PLANS = UNLOCK_PLANS;