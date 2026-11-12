// ============================================================
// FILE: lib/moderation.js
// ============================================================
// Marketplace listing moderation for Volant Plaza.
//
// Rules:
//   - Trusted sellers publish instantly.
//   - New / untrusted sellers publish instantly too, but their
//     listing is put in a shadow queue (`shadowReview: true`) so an
//     admin sees it without blocking the seller.
//   - Prohibited words, obvious spam and unsafe links hold a listing
//     for review instead of publishing it.
//   - Images are checked for safe URLs and, when
//     GOOGLE_VISION_API_KEY is configured, scanned for explicit or
//     violent content.
//
// The module is server-only: it is used by /api/mall-moderate and
// /api/mall-report and never shipped to the browser.
// ============================================================

const BLOCKED_TERMS = [
    // Weapons
    'gun', 'firearm', 'pistol', 'rifle', 'ammunition', 'ammo', 'silencer',
    'explosive', 'grenade', 'bomb', 'landmine',
    // Drugs
    'cocaine', 'heroin', 'methamphetamine', 'meth', 'weed', 'marijuana',
    'cannabis', 'tramadol', 'codeine', 'ecstasy', 'mdma', 'fentanyl',
    // Adult / exploitation
    'porn', 'pornography', 'nude', 'nudes', 'sex toy', 'escort',
    'child porn', 'csam',
    // Wildlife / contraband
    'ivory', 'rhino horn', 'pangolin', 'endangered species',
    // Fraud / scams
    'fake', 'replica', 'counterfeit', 'clone card', 'credit card dump',
    'cvv', 'fullz', 'hacked account', 'stolen', 'money doubling',
    'double your money', 'ponzi', 'pyramid scheme',
    // Regulated
    'human organ', 'kidney for sale', 'passport for sale',
    'driving licence for sale', 'visa for sale'
];

const SPAM_PATTERNS = [
    /\b(?:wa\.me|chat\.whatsapp\.com)\/\S+/i,
    /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\/\S+/i,
    /(.)\1{9,}/,
    /\b(?:100|1000|10000)%\s*(?:guaranteed|original|authentic)\b/i
];

const SUSPICIOUS_TLDS = [
    '.zip', '.mov', '.top', '.xyz', '.click', '.link', '.work', '.loan'
];

const MAX_TITLE = 160;
const MAX_DESCRIPTION = 5000;
const MAX_IMAGES = 8;

function normalize(text) {
    return String(text == null ? '' : text)
        .toLowerCase()
        .replace(/[^a-z0-9\s'&+.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function findBlockedTerm(text) {
    const haystack = normalize(text);
    if (!haystack) return null;
    for (const term of BLOCKED_TERMS) {
        const needle = normalize(term);
        if (!needle) continue;
        const re = new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?($|\\s)`, 'i');
        if (re.test(haystack)) return term;
    }
    return null;
}

function findSpam(text) {
    const value = String(text == null ? '' : text);
    if (!value) return null;
    for (const re of SPAM_PATTERNS) {
        if (re.test(value)) return re.source;
    }
    if ((value.match(/https?:\/\//gi) || []).length > 3) return 'too many links';
    return null;
}

function safeImageUrl(url) {
    try {
        const parsed = new URL(String(url));
        if (parsed.protocol !== 'https:') return false;
        const path = parsed.pathname.toLowerCase();
        if (/\.(?:exe|dll|bat|cmd|ps1|sh|php|js|html?|svg)$/.test(path)) return false;
        const host = parsed.hostname.toLowerCase();
        for (const tld of SUSPICIOUS_TLDS) {
            if (host.endsWith(tld)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function scanImageUrls(images) {
    if (!Array.isArray(images)) return { ok: true, urls: [], rejected: [] };
    const urls = [];
    const rejected = [];
    for (const raw of images) {
        if (typeof raw !== 'string') continue;
        const url = raw.trim();
        if (!url) continue;
        if (!safeImageUrl(url)) {
            rejected.push(url.slice(0, 200));
            continue;
        }
        if (!urls.includes(url)) urls.push(url);
        if (urls.length >= MAX_IMAGES) break;
    }
    return { ok: rejected.length === 0, urls, rejected };
}

async function visionScan(url) {
    const key = process.env.GOOGLE_VISION_API_KEY || '';
    if (!key) return { skipped: true, safe: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    requests: [{
                        image: { source: { imageUri: url } },
                        features: [{ type: 'SAFE_SEARCH_DETECTION' }]
                    }]
                }),
                signal: controller.signal
            }
        );
        if (!res.ok) return { skipped: false, safe: true, error: `vision_${res.status}` };
        const json = await res.json().catch(() => ({}));
        const annotation = json.responses && json.responses[0] && json.responses[0].safeSearchAnnotation;
        if (!annotation) return { skipped: false, safe: true };
        const risky = ['adult', 'racy', 'violence'];
        const bad = risky.filter(field => {
            const value = String(annotation[field] || '').toUpperCase();
            return value === 'LIKELY' || value === 'VERY_LIKELY';
        });
        return { skipped: false, safe: bad.length === 0, flags: bad };
    } catch (error) {
        return { skipped: false, safe: true, error: String(error && error.message || error) };
    } finally {
        clearTimeout(timer);
    }
}

async function scanImages(images) {
    const base = scanImageUrls(images);
    if (!base.ok) return { ...base, visionFlags: [] };
    const visionFlags = [];
    const checks = base.urls.slice(0, 4).map(async (url) => {
        const result = await visionScan(url);
        if (!result.safe) visionFlags.push({ url, flags: result.flags || [] });
    });
    await Promise.all(checks);
    return {
        ok: visionFlags.length === 0,
        urls: base.urls,
        rejected: base.rejected,
        visionFlags
    };
}

function daysSince(value) {
    if (!value) return 0;
    let ms = 0;
    if (typeof value.toDate === 'function') ms = value.toDate().getTime();
    else if (typeof value === 'object' && typeof value.seconds === 'number') ms = value.seconds * 1000;
    else if (typeof value === 'string' || value instanceof Date) ms = new Date(value).getTime();
    if (!ms || Number.isNaN(ms)) return 0;
    return Math.max(0, (Date.now() - ms) / 86400000);
}

function sellerTrust(store) {
    const s = store || {};
    if (s.suspended === true || s.banned === true) {
        return { trusted: false, blocked: true, reason: 'Seller account is suspended.' };
    }
    const strikes = Number(s.moderationStrikes || 0);
    if (strikes >= 3) {
        return { trusted: false, blocked: true, reason: 'Seller has too many moderation strikes.' };
    }
    if (s.trustedSeller === true) {
        return { trusted: true, blocked: false, reason: 'Verified trusted seller.' };
    }
    const ageDays = daysSince(s.approvedAt || s.createdAt);
    const sales = Number(s.salesCount || s.saleCount || 0);
    if (ageDays >= 30 && sales >= 10 && strikes === 0) {
        return { trusted: true, blocked: false, reason: 'Established seller with a clean record.' };
    }
    return { trusted: false, blocked: false, reason: 'New or unverified seller.' };
}

/**
 * Decide how a listing should be handled.
 *
 * Returns:
 *   action:  'publish' | 'shadow' | 'hold'
 *   status:  Firestore status to store ('active' | 'stockout' | 'pending')
 *   reasons: human-readable moderation notes
 */
async function evaluateListing({ product, store, images }) {
    const reasons = [];
    const title = String(product && product.title || '').slice(0, MAX_TITLE);
    const description = String(product && product.description || '').slice(0, MAX_DESCRIPTION);
    const combined = `${title}\n${description}`;

    const trust = sellerTrust(store);
    if (trust.blocked) {
        return {
            action: 'hold',
            status: 'pending',
            trust,
            reasons: [trust.reason],
            shadowReview: false,
            moderationStatus: 'held'
        };
    }

    const blockedTerm = findBlockedTerm(combined);
    if (blockedTerm) reasons.push(`Contains a prohibited term (${blockedTerm}).`);

    const spam = findSpam(combined);
    if (spam) reasons.push('Looks like spam or an unsafe link.');

    const imageScan = await scanImages(
        Array.isArray(images) ? images : (product && product.images)
    );
    if (!imageScan.ok) reasons.push('One or more images failed safety checks.');

    const stock = Number(product && product.stock || 0);
    let status = stock > 0 ? 'active' : 'stockout';

    if (reasons.length) {
        return {
            action: 'hold',
            status: 'pending',
            trust,
            reasons,
            shadowReview: false,
            moderationStatus: 'held',
            images: imageScan.urls
        };
    }

    if (!trust.trusted) {
        return {
            action: 'shadow',
            status,
            trust,
            reasons: [trust.reason],
            shadowReview: true,
            moderationStatus: 'shadow_review',
            images: imageScan.urls
        };
    }

    return {
        action: 'publish',
        status,
        trust,
        reasons: [trust.reason],
        shadowReview: false,
        moderationStatus: 'approved',
        images: imageScan.urls
    };
}

module.exports = {
    BLOCKED_TERMS,
    MAX_TITLE,
    MAX_DESCRIPTION,
    MAX_IMAGES,
    findBlockedTerm,
    findSpam,
    scanImageUrls,
    scanImages,
    sellerTrust,
    evaluateListing
};