// ============================================================
// FILE: api/mall-webhook.js
// ============================================================
// Vercel Serverless Function - Paystack webhook for Volant Mall.
// Verifies signatures with the Volant Mall Paystack secret key,
// so events from the Mall business never collide with Volant
// Reads or Volant Lyrics.
//
// On charge.success it replays order finalisation (same core as
// /api/mall-finalize-order) so an order is recorded + stock is
// decremented even if the buyer closed the tab before the callback.
// Idempotent: already-finalised references are skipped.
// ============================================================

const crypto = require('crypto');
const { db } = require('../lib/mall-admin');
const { finaliseOrder } = require('./mall-finalize-order');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const signature = req.headers['x-paystack-signature'];
        const mallSecret = process.env.MALL_PAYSTACK_SECRET_KEY;

        if (!signature || !mallSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const hash = crypto
            .createHmac('sha512', mallSecret)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== signature) {
            return res.status(401).json({ error: 'Invalid signature' });
        }

        const event = req.body;
        console.log('Mall webhook: ' + event.event);

        if (event.event === 'charge.success') {
            const txn = event.data;
            const reference = txn && txn.reference;

            if (reference) {
                const adminDb = db();

                // Load the checkout session created client-side before payment.
                const checkoutSnap = await adminDb.collection('mall-checkouts').doc(reference).get();
                if (checkoutSnap.exists) {
                    const c = checkoutSnap.data();
                    const result = await finaliseOrder(adminDb, {
                        reference,
                        checkout: {
                            items: c.items || [],
                            shipping: c.shipping || null,
                            email: c.email || '',
                            phone: c.phone || '',
                            uid: c.userId || ''
                        }
                    });
                    console.log('Webhook finalise: ' + JSON.stringify({ ok: result.ok, already: result.alreadyFinalized, orderIds: (result.orderIds || []).length }));
                } else {
                    console.warn('Mall webhook: no checkout session found for ' + reference + ' (may be pre-rollout payment)');
                }
            }
        }

        return res.status(200).json({ status: 'success' });
    } catch (error) {
        console.error('Mall webhook error:', error);
        return res.status(200).json({ status: 'error' });
    }
};