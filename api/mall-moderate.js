// ============================================================
// FILE: api/mall-moderate.js
// ============================================================
// Server-side listing moderation for Volant Plaza.
//
// Called after a seller publishes or edits a product (and by the
// admin tools). It re-checks the stored listing with the shared
// moderation rules, then applies the verdict with the Admin SDK so
// the outcome is the same no matter which browser was used.
//
// POST body: { productId }
// Header:    Authorization: Bearer <Firebase ID token>
// ============================================================

const { db, verifyToken } = require('../lib/mall-admin');
const { evaluateListing, sellerTrust } = require('../lib/moderation');

function statusFor(action, stock) {
    if (action === 'hold') return 'pending';
    return Number(stock) > 0 ? 'active' : 'stockout';
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed. Use POST.' });
    }

    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) {
        return res.status(401).json({ success: false, message: 'Sign in to continue.' });
    }

    let identity;
    try {
        identity = await verifyToken(token);
    } catch {
        return res.status(401).json({ success: false, message: 'Your session has expired. Sign in again.' });
    }

    const body = req.body && typeof req.body === 'object'
        ? req.body
        : (() => { try { return JSON.parse(String(req.body || '{}')); } catch { return {}; } })();
    const productId = String(body.productId || '').trim();
    if (!productId) {
        return res.status(400).json({ success: false, message: 'Missing productId.' });
    }

    try {
        const adminDb = db();
        const productRef = adminDb.collection('mall-products').doc(productId);
        const productSnap = await productRef.get();
        if (!productSnap.exists) {
            return res.status(404).json({ success: false, message: 'Product not found.' });
        }

        const product = productSnap.data() || {};
        const ownerId = String(product.ownerId || '').trim();
        if (ownerId !== identity.uid) {
            const adminSnap = await adminDb.collection('admins').doc(identity.uid).get();
            if (!adminSnap.exists) {
                return res.status(403).json({ success: false, message: 'You can only moderate your own listings.' });
            }
        }

        const storeSnap = ownerId
            ? await adminDb.collection('mall-sellers').doc(ownerId).get()
            : null;
        const store = storeSnap && storeSnap.exists ? storeSnap.data() : {};

        const verdict = await evaluateListing({ product, store });

        const patch = {
            status: statusFor(verdict.action, product.stock),
            moderationStatus: verdict.moderationStatus,
            shadowReview: verdict.shadowReview === true,
            moderationReasons: verdict.reasons || [],
            moderationAction: verdict.action,
            moderatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
        };

        // Never let a held listing stay visible.
        if (verdict.action === 'hold') {
            patch.hidden = true;
            patch.status = 'pending';
        } else {
            patch.hidden = false;
        }

        if (Array.isArray(verdict.images)) {
            patch.images = verdict.images;
            patch.hasImages = verdict.images.length > 0;
        }

        await productRef.set(patch, { merge: true });

        return res.status(200).json({
            success: true,
            action: verdict.action,
            status: patch.status,
            moderationStatus: verdict.moderationStatus,
            shadowReview: verdict.shadowReview === true,
            reasons: verdict.reasons || []
        });
    } catch (error) {
        console.error('Moderation error:', error);
        return res.status(500).json({
            success: false,
            message: String(error && error.message || error).slice(0, 300)
        });
    }
};

module.exports.sellerTrust = sellerTrust;