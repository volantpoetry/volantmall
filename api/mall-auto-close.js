// ============================================================
// FILE: api/mall-auto-close.js
// ============================================================
// Volant Mall - scheduled maintenance cron.
//
// Vercel Cron (`{ "path": "/api/mall-auto-close", "schedule": "0 3 * * *" }`)
// runs this once a day at 3:00 AM (Hobby plans are limited to daily crons). It:
//   1. auto-closes stale 'completed' orders -> 'received'
//      (AUTO_COMPLETE_DAYS after they were delivered)
//   2. nudges sellers whose orders sit in 'processing' for too long
//
// It writes server-side (Admin SDK), so no client auth is needed, and it
// is idempotent: only touches orders that genuinely need it.
// ============================================================

const { db } = require('../lib/mall-admin');

const AUTO_COMPLETE_DAYS = 6;
const PROCESSING_NUDGE_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

function now() {
    return require('firebase-admin').firestore.FieldValue.serverTimestamp();
}
function toMs(v) {
    if (!v) return 0;
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (v.seconds) return v.seconds * 1000;
    if (typeof v === 'number') return v;
    const n = new Date(v).getTime();
    return isNaN(n) ? 0 : n;
}

async function autoCloseStale() {
    const admin = require('firebase-admin');
    const cutoff = Date.now() - AUTO_COMPLETE_DAYS * DAY_MS;
    const snap = await db().collection('mall-orders')
        .where('orderStatus', '==', 'completed')
        .limit(400)
        .get();

    const closed = [];
    const batch = db().batch();
    snap.forEach(doc => {
        const o = doc.data();
        let deliveredAt = toMs(o.deliveredAt);
        if (!deliveredAt && Array.isArray(o.trace)) {
            const c = o.trace.find(t => t.status === 'completed');
            deliveredAt = toMs(c && c.at);
        }
        if (!deliveredAt || deliveredAt >= cutoff) return;
        const trace = Array.isArray(o.trace) ? o.trace.slice() : [];
        trace.push({ status: 'received', at: admin.firestore.Timestamp.now(), note: 'Auto-completed (no response)' });
        batch.update(doc.ref, {
            orderStatus: 'received',
            trace: trace,
            receivedAt: now()
        });
        closed.push(doc.id);
    });
    if (closed.length) {
        await batch.commit();
        console.log('[auto-close] closed', closed.length, 'stale orders');
    }
    return closed.length;
}

async function nudgeProcessing() {
    const cutoff = Date.now() - PROCESSING_NUDGE_DAYS * DAY_MS;
    const snap = await db().collection('mall-orders')
        .where('orderStatus', '==', 'processing')
        .limit(300)
        .get();

    let nudged = 0;
    for (const doc of snap.docs) {
        const o = doc.data();
        const purchased = toMs(o.purchasedAt) || toMs(o.createdAt);
        if (!purchased || purchased >= cutoff) continue;
        try {
            const prev = await db().collection('notifications')
                .where('userId', '==', (o.sellerId || '_'))
                .where('ref', '==', (o.paymentRef || o.ref || ''))
                .where('type', '==', 'nudge')
                .limit(1)
                .get();
            if (!prev.empty) continue;
            await db().collection('notifications').add({
                userId: o.sellerId || '_',
                type: 'nudge',
                title: 'Order awaiting fulfilment ⏰',
                body: 'Order #' + String(o.ref || doc.id).slice(0, 18) + ' has been processing for over ' + PROCESSING_NUDGE_DAYS + ' days. Please update it so the buyer knows the status.',
                orderId: doc.id,
                ref: o.paymentRef || o.ref || '',
                read: false,
                createdAt: now()
            });
            nudged++;
        } catch (e) {
            console.warn('[auto-close] nudge error for', doc.id, e.message);
        }
    }
    if (nudged) console.log('[auto-close] nudged', nudged, 'sellers');
    return nudged;
}

module.exports = async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ ok: false, message: 'Method not allowed' });
    }
    try {
        const closed = await autoCloseStale();
        const nudged = await nudgeProcessing();
        return res.status(200).json({ ok: true, closed, nudged });
    } catch (e) {
        console.error('[auto-close] cron error:', e);
        return res.status(500).json({ ok: false, message: String(e.message || e) });
    }
};