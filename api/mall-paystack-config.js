// ============================================================
// FILE: api/mall-paystack-config.js
// ============================================================
// Vercel Serverless Function - Volant Mall Paystack settings
// Serves ONLY the PUBLIC key (+ safe config) for the Volant
// Mall Paystack business. The secret key never leaves the server.
// (Volant Reads uses api/paystack-config.js, Volant Lyrics uses
// lyrics/api/lyrics-paystack-config.js - each platform runs its own
// Paystack business so subaccounts are kept separate.)
// ============================================================

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, message: 'Method not allowed. Use GET.' });
    }

    const publicKey = process.env.MALL_PAYSTACK_PUBLIC_KEY || '';
    const secretKey = process.env.MALL_PAYSTACK_SECRET_KEY || '';

    return res.status(200).json({
        success: !!publicKey,
        publicKey: publicKey,
        mode: secretKey.startsWith('sk_test_') ? 'test' : 'live',
        commissionRate: Number(process.env.MALL_PAYSTACK_COMMISSION) || 10,
        feeBearer: process.env.MALL_PAYSTACK_FEE_BEARER || 'account'
    });
};