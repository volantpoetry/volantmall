// ============================================================
// FILE: lib/mall-admin.js
// ============================================================
// Shared Firebase Admin bootstrap for Volant Mall serverless
// functions. Initialised lazily and only when a function needs
// it, so API routes that don't touch Firestore stay fast.
//
// Kept OUTSIDE api/ so Vercel does not count it as a serverless
// function (Hobby plan caps deployments at 12 functions).
//
// Service account JSON goes in the Vercel env var
//   SERVICE_ACCOUNT_KEY   (base64-encoded JSON)
// or directly as JSON text in SERVICE_ACCOUNT.
// ============================================================

let app = null;
let firebaseAdmin = null;

function loadAdmin() {
    if (app) return firebaseAdmin;
    const candidates = [
        process.env.SERVICE_ACCOUNT_KEY ? Buffer.from(process.env.SERVICE_ACCOUNT_KEY, 'base64').toString('utf8') : null,
        process.env.SERVICE_ACCOUNT || null,
        process.env.GOOGLE_CREDENTIALS || null
    ].filter(Boolean);
    if (candidates.length === 0) {
        throw new Error('Firebase Admin SDK is not configured. Set SERVICE_ACCOUNT_KEY.');
    }
    try {
        firebaseAdmin = require('firebase-admin');
    } catch (err) {
        throw new Error('firebase-admin is not installed. Add it to dependencies before deploying.');
    }
    let parsed = null;
    for (const text of candidates) {
        try { parsed = JSON.parse(text); if (parsed && parsed.project_id) break; } catch (e) { /* try next */ }
    }
    if (!parsed || !parsed.project_id) {
        throw new Error('SERVICE_ACCOUNT_KEY is not a valid service account JSON.');
    }
    app = firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(parsed),
        projectId: parsed.project_id
    });
    return firebaseAdmin;
}

function db() {
    return loadAdmin().firestore();
}

// Verify a Firebase ID token and return the decoded UID, or throw.
async function verifyToken(idToken) {
    if (!idToken) throw new Error('Missing auth token');
    const admin = loadAdmin();
    const decoded = await admin.auth().verifyIdToken(String(idToken));
    if (!decoded || !decoded.uid) throw new Error('Invalid token');
    return decoded;
}

async function isAdminUser(uid) {
    const admDoc = await db().collection('admins').doc(uid).get();
    return admDoc.exists;
}

module.exports = { db, verifyToken, isAdminUser, loadAdmin };