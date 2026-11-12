// ============================================================
// FILE: api/mall-report.js
// ============================================================
// Buyer reports for Volant Plaza listings.
//
// POST body: { productId, reason, details }
// Header:    Authorization: Bearer <Firebase ID token>
//
// A listing is auto-hidden after three independent reports until an
// admin reviews it. Reports are stored in `mall-reports` for the
// admin dashboard.
// ============================================================

const { db, verifyToken } = require('../lib/mall-admin');

const ALLOWED_REASONS = new Set([
    'prohibited',
    'counterfeit',
    'scam',
    'misleading',
    'offensive',
    'wrong-category',
    'other'
]);

const AUTO_HIDE_THRESHOLD = 3;

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed. Use POST.' });
    }

    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) {
        return res.status(401).json({ success: false, message: 'Sign in to report a listing.' });
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
    const reason = String(body.reason || '').trim().toLowerCase();
    const details = String(body.details || '').trim().slice(0, 1000);

    if (!productId) {
        return res.status(400).json({ success: false, message: 'Missing productId.' });
    }
    if (!ALLOWED_REASONS.has(reason)) {
        return res.status(400).json({ success: false, message: 'Choose a valid reason.' });
    }

    try {
        const adminDb = db();
        const productRef = adminDb.collection('mall-products').doc(productId);
        const productSnap = await productRef.get();
        if (!productSnap.exists) {
            return res.status(404).json({ success: false, message: 'This listing no longer exists.' });
        }

        const product = productSnap.data() || {};
        const existing = await adminDb
            .collection('mall-reports')
            .where('productId', '==', productId)
            .where('reportedBy', '==', identity.uid)
            .limit(1)
            .get();

        if (!existing.empty) {
            return res.status(200).json({
                success: true,
                alreadyReported: true,
                message: 'You already reported this listing. Our team is reviewing it.'
            });
        }

        const now = require('firebase-admin').firestore.FieldValue.serverTimestamp();
        const reportRef = adminDb.collection('mall-reports').doc();
        await reportRef.set({
            productId,
            productTitle: String(product.title || '').slice(0, 200),
            ownerId: String(product.ownerId || ''),
            storeName: String(product.storeName || ''),
            reason,
            details,
            reportedBy: identity.uid,
            reporterEmail: String(identity.email || ''),
            status: 'open',
            createdAt: now
        });

        const previousCount = Number(product.reportCount || 0);
        const reportCount = previousCount + 1;
        const shouldHide = reportCount >= AUTO_HIDE_THRESHOLD && product.hidden !== true;

        const patch = { reportCount };
        if (shouldHide) {
            patch.hidden = true;
            patch.status = 'pending';
            patch.moderationStatus = 'reported_auto';
            patch.autoHiddenAt = now;
            patch.moderationReasons = ['Auto-hidden after multiple buyer reports.'];
        }
        await productRef.set(patch, { merge: true });

        return res.status(201).json({
            success: true,
            reportId: reportRef.id,
            reportCount,
            autoHidden: shouldHide,
            message: shouldHide
                ? 'Thanks. This listing has been hidden while our team reviews it.'
                : 'Thanks. Our team will review this listing.'
        });
    } catch (error) {
        console.error('Report error:', error);
        return res.status(500).json({
            success: false,
            message: String(error && error.message || error).slice(0, 300)
        });
    }
};