// ============================================================
// FILE: api/mall-bridge.js
// ============================================================
// Server-to-server bridge used by Aerofindex.
//
// Authentication is a shared secret header (x-plaza-bridge-secret).
// Actions:
//   upsert-product  publish / update a product listing
//   stock           set the exact Plaza stock level after a sale or edit
//   unpublish       remove a product from the public storefront
//
// The secret stays in Vercel env vars and is never shipped to browsers.
// ============================================================

const { db } = require('../lib/mall-admin');
const bridge = require('../lib/mall-bridge');

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET') {
        return res.status(200).json({
            success: true,
            service: 'volant-plaza-bridge',
            configured: Boolean(process.env.PLAZA_BRIDGE_SECRET)
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed. Use POST.' });
    }

    if (!bridge.verifySecret(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized bridge request.' });
    }

    const body = req.body && typeof req.body === 'object'
        ? req.body
        : (() => {
            try { return JSON.parse(String(req.body || '{}')); } catch { return {}; }
        })();

    const action = String(body.action || '').trim();
    if (!action) {
        return res.status(400).json({ success: false, message: 'Missing action.' });
    }

    try {
        const adminDb = db();
        if (action === 'upsert-product') {
            const result = await bridge.upsertProduct(adminDb, body.product || {});
            return res.status(result.statusCode || 200).json({ success: result.ok, ...result });
        }
        if (action === 'stock') {
            const result = await bridge.patchStock(adminDb, body);
            return res.status(result.statusCode || 200).json({ success: result.ok, ...result });
        }
        if (action === 'unpublish') {
            const result = await bridge.unpublishProduct(adminDb, body);
            return res.status(result.statusCode || 200).json({ success: result.ok, ...result });
        }
        if (action === 'list-products' || action === 'pull-products') {
            const result = await bridge.listProducts(adminDb, body);
            return res.status(result.statusCode || 200).json({ success: result.ok, ...result });
        }
        if (action === 'get-product') {
            const result = await bridge.getProduct(adminDb, body);
            return res.status(result.statusCode || 200).json({ success: result.ok, ...result });
        }
        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (error) {
        console.error('Plaza bridge error:', error);
        return res.status(500).json({
            success: false,
            message: String(error && error.message || error).slice(0, 300)
        });
    }
};