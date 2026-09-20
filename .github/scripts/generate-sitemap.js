/**
 * 🔥 Auto Sitemap Generator for Volant Mall
 * ONLY includes URLs from the volantmall.vercel.app domain
 * Uses Firebase Admin SDK with Service Account from GitHub Secrets
 * Runs on GitHub Actions (inside the mall repo)
 */

const fs = require('fs');
const path = require('path');

// ---- CONFIG ----
const domain = 'https://volantmall.vercel.app';
const publicFolder = './';
const MAX_PRODUCTS = 5000;
const MAX_SELLERS = 5000;

// ✅ STATIC PAGES TO INDEX (all under volantmall.vercel.app)
const allowedPages = [
  // Mall root
  'index.html',

  // Public mall pages
  'submit.html',
  'faq.html',
  'refund.html',

  // NOTE: about / contact / terms / privacy live on
  // volantpoetry.vercel.app/shared/* — not on this domain.
];

// 🚫 PAGES THAT MUST NEVER APPEAR IN THE SITEMAP
// These are private / user-specific / admin pages. Also blocked in robots.txt.
const blockedPaths = [
  '/admin',
  '/dashboard',
  '/manage',
  '/login',
  '/signup',
  '/verify',
  '/reset',
  '/account',
  '/orders.html',
  '/notifications.html',
  '/cart',
  '/checkout',
  '/shared/verify-email.html',
  '/shared/universal-login.html',
  '/shared/universal-signup.html',
  '/shared/users-reset.html',
  '/user-profile.html'
];

// ❌ NO EXTERNAL URLS
const externalUrls = [];

// ---- XML ESCAPE FUNCTION ----
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---- SAFETY: is this URL blocked? ----
function isBlocked(url) {
  const lower = url.toLowerCase();
  return blockedPaths.some(p => lower.includes(p.toLowerCase()));
}

// ---- Shared Firebase init helper ----
function initFirebase() {
  const admin = require('firebase-admin');

  if (admin.apps && admin.apps.length > 0) {
    return admin;
  }

  let serviceAccount;
  const secretKey = process.env.FIREBASE_KEY ||
                   process.env.FIREBASE_SERVICE_ACCOUNT ||
                   process.env.SERVICE_ACCOUNT_KEY;

  console.log(`🔐 Secret available: ${!!secretKey}`);

  if (secretKey) {
    try {
      serviceAccount = JSON.parse(secretKey);
      console.log('✅ Parsed service account JSON');
    } catch (parseError) {
      console.log('⚠️ Not JSON, trying base64 decode...');
      try {
        const decoded = Buffer.from(secretKey, 'base64').toString('utf8');
        serviceAccount = JSON.parse(decoded);
        console.log('✅ Decoded base64 service account');
      } catch (base64Error) {
        console.log('❌ Failed to parse service account:', base64Error.message);
        return null;
      }
    }
  } else {
    const keyPath = path.join(process.cwd(), 'service-account-key.json');
    if (fs.existsSync(keyPath)) {
      serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      console.log('✅ Loaded service account from local file');
    } else {
      console.log('❌ No service account key found');
      return null;
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin initialized');
  return admin;
}

// ---- Timestamp helper ----
function pickTimestamp(data) {
  const candidates = ['createdAt', 'updatedAt', 'approvedAt', 'publishedAt'];
  for (const key of candidates) {
    const val = data[key];
    if (!val) continue;
    if (typeof val === 'object' && val.toDate) {
      try { return val.toDate().toISOString(); } catch (e) {}
    }
    if (typeof val === 'string') return val;
    if (typeof val === 'number') {
      try { return new Date(val).toISOString(); } catch (e) {}
    }
  }
  return new Date().toISOString();
}

// ============================================================
// 🛒 FETCH PRODUCTS FROM FIRESTORE
// ============================================================
async function fetchProductsFromFirestore() {
  console.log('\n🛒 Starting fetchProductsFromFirestore...');

  try {
    console.log('📦 Loading firebase-admin...');
    const admin = initFirebase();
    if (!admin) return [];

    const db = admin.firestore();
    const allProducts = [];

    console.log('🔥 Fetching active products...');
    const snapshot = await db.collection('mall-products')
      .where('status', 'in', ['active', 'stockout'])
      .get();

    if (snapshot.empty) {
      console.log('⚠️ No active products found');
      return [];
    }

    console.log(`📄 Found ${snapshot.size} active products`);

    snapshot.forEach(doc => {
      const data = doc.data();
      allProducts.push({
        id: doc.id,
        title: data.title || 'Untitled',
        timestamp: pickTimestamp(data)
      });
    });

    console.log(`✅ Total products fetched: ${allProducts.length}`);
    return allProducts;

  } catch (err) {
    console.error('❌ Failed to fetch products:', err.message);
    return [];
  }
}

// ============================================================
// 🏪 FETCH SELLERS FROM FIRESTORE
// ============================================================
async function fetchSellersFromFirestore() {
  console.log('\n🏪 Starting fetchSellersFromFirestore...');

  try {
    const admin = initFirebase();
    if (!admin) return [];

    const db = admin.firestore();
    const allSellers = [];

    console.log('🔥 Fetching active sellers...');
    const snapshot = await db.collection('mall-sellers')
      .where('active', '==', true)
      .get();

    if (snapshot.empty) {
      console.log('⚠️ No active sellers found');
      return [];
    }

    console.log(`📄 Found ${snapshot.size} active sellers`);

    snapshot.forEach(doc => {
      const data = doc.data();
      allSellers.push({
        id: doc.id,
        storeName: data.storeName || 'Store',
        timestamp: pickTimestamp(data)
      });
    });

    console.log(`✅ Total sellers fetched: ${allSellers.length}`);
    return allSellers;

  } catch (err) {
    console.error('❌ Failed to fetch sellers:', err.message);
    return [];
  }
}

// ============================================================
// 🛒 Generate product URLs
// ============================================================
function generateProductUrls(products) {
  const results = [];
  let count = 0;

  for (const p of products) {
    if (count >= MAX_PRODUCTS) break;

    const url = `${domain}/details.html?id=${encodeURIComponent(p.id)}`;

    if (isBlocked(url)) {
      console.log(`🚫 Skipping blocked URL: ${url}`);
      continue;
    }

    let lastmod = new Date().toISOString();
    if (p.timestamp) {
      try {
        const date = new Date(p.timestamp);
        if (!isNaN(date.getTime())) lastmod = date.toISOString();
      } catch (e) {}
    }

    results.push({
      loc: url,
      lastmod: lastmod,
      changefreq: 'weekly',
      priority: '0.8'
    });

    count++;
  }

  return results;
}

// ============================================================
// 🏪 Generate seller URLs
// ============================================================
function generateSellerUrls(sellers) {
  const results = [];
  let count = 0;

  for (const s of sellers) {
    if (count >= MAX_SELLERS) break;

    const url = `${domain}/store.html?store=${encodeURIComponent(s.id)}`;

    if (isBlocked(url)) {
      console.log(`🚫 Skipping blocked URL: ${url}`);
      continue;
    }

    let lastmod = new Date().toISOString();
    if (s.timestamp) {
      try {
        const date = new Date(s.timestamp);
        if (!isNaN(date.getTime())) lastmod = date.toISOString();
      } catch (e) {}
    }

    results.push({
      loc: url,
      lastmod: lastmod,
      changefreq: 'weekly',
      priority: '0.7'
    });

    count++;
  }

  return results;
}

// ---- Get static URL ----
function getUrlWithHtml(filePath) {
  let cleanPath = filePath.replace(/^\.\//, '');
  if (cleanPath === 'index.html') return '';
  if (cleanPath.endsWith('/index.html')) return cleanPath.replace(/\/index\.html$/, '/');
  return cleanPath;
}

// ---- Build XML ----
function buildXML(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">

${urls.map(u => `
  <url>
    <loc>${escapeXml(u.loc)}</loc>
    <lastmod>${escapeXml(u.lastmod)}</lastmod>
    <changefreq>${escapeXml(u.changefreq)}</changefreq>
    <priority>${escapeXml(u.priority)}</priority>
  </url>
`).join('')}

</urlset>`;
}

// ---- Generate robots.txt ----
function generateRobotsTxt() {
  const robots = `# Robots.txt for Volant Mall
User-agent: *
Allow: /

# Root
Allow: /$
Allow: /index.html

# Mall pages
Allow: /submit.html
Allow: /faq.html
Allow: /refund.html
Allow: /details.html
Allow: /store.html

# NOTE: Shared pages (about, contact, terms, privacy) live on
# volantpoetry.vercel.app/shared/* — not on this domain.

# Block admin, private, and user-specific pages
${blockedPaths.map(p => `Disallow: ${p}`).join('\n')}

# Block Google verification
Disallow: /google*.html

# Block non-HTML files
Disallow: /*.js$
Disallow: /*.css$
Disallow: /*.json$
Disallow: /*.xml$

# Block node_modules
Disallow: /node_modules/

# Block images
Disallow: /images/

# Block 404
Disallow: /404.html

Sitemap: ${domain}/sitemap.xml`;

  fs.writeFileSync(path.join(publicFolder, 'robots.txt'), robots, 'utf8');
  console.log('✅ robots.txt generated');
}

// ---- MAIN ----
async function generateSitemap() {
  try {
    console.log("🧠 Generating SEO sitemap for Volant Mall...");
    console.log(`📁 Domain: ${domain}`);
    console.log(`📄 Targeting ${allowedPages.length} static pages...`);
    console.log(`🚫 ${blockedPaths.length} blocked paths excluded`);

    // 🔥 SELF-HEALING: always remove old files first.
    const sitemapPath = path.join(publicFolder, 'sitemap.xml');
    const robotsPath = path.join(publicFolder, 'robots.txt');
    if (fs.existsSync(sitemapPath)) {
      fs.unlinkSync(sitemapPath);
      console.log('🧹 Removed old sitemap.xml');
    }
    if (fs.existsSync(robotsPath)) {
      fs.unlinkSync(robotsPath);
      console.log('🧹 Removed old robots.txt');
    }

    // 1. Static pages
    const staticResults = [];
    for (const page of allowedPages) {
      const fullPath = path.join(publicFolder, page);
      if (!fs.existsSync(fullPath)) {
        console.log(`⚠️ Warning: ${page} not found, skipping...`);
        continue;
      }

      const stats = fs.statSync(fullPath);
      const urlPath = getUrlWithHtml(page);
      const url = urlPath === '' ? domain : `${domain}/${urlPath}`;

      if (isBlocked(url)) {
        console.log(`🚫 Skipping blocked static page: ${url}`);
        continue;
      }

      let priority = '0.8';
      if (page === 'index.html' || urlPath === '') priority = '1.0';
      else if (page === 'submit.html') priority = '0.9';
      else if (page === 'faq.html' || page === 'refund.html') priority = '0.8';

      staticResults.push({
        loc: url,
        lastmod: stats.mtime.toISOString(),
        changefreq: 'weekly',
        priority: priority
      });
    }

    console.log(`✅ ${staticResults.length} static pages generated`);
    staticResults.forEach(r => console.log(`   ${r.priority} → ${r.loc}`));

    // 2. Dynamic products
    console.log("\n🛒 Fetching products from Firestore...");
    const products = await fetchProductsFromFirestore();
    const productResults = generateProductUrls(products);
    console.log(`✅ ${productResults.length} product URLs generated (priority 0.8)`);

    // 3. Dynamic sellers
    console.log("\n🏪 Fetching sellers from Firestore...");
    const sellers = await fetchSellersFromFirestore();
    const sellerResults = generateSellerUrls(sellers);
    console.log(`✅ ${sellerResults.length} seller URLs generated (priority 0.7)`);

    if (productResults.length === 0) {
      console.log("\n⚠️ WARNING: No product URLs generated!");
    }
    if (sellerResults.length === 0) {
      console.log("\n⚠️ WARNING: No seller URLs generated!");
    }

    // 4. Combine
    const allUrls = [...staticResults, ...productResults, ...sellerResults];

    console.log(`\n📊 Total: ${allUrls.length} URLs`);
    console.log(`   Static: ${staticResults.length}`);
    console.log(`   Dynamic Products: ${productResults.length}`);
    console.log(`   Dynamic Sellers: ${sellerResults.length}`);

    // 5. Build sitemap
    const xml = buildXML(allUrls);

    // 🛡️ SANITY CHECK: each <url> block must contain exactly ONE <lastmod>.
    const urlBlocks = xml.split('<url>').slice(1);
    let badBlocks = 0;
    for (const block of urlBlocks) {
      const lastmodCount = (block.match(/<lastmod>/g) || []).length;
      if (lastmodCount !== 1) {
        badBlocks++;
        console.error(`❌ URL block has ${lastmodCount} <lastmod> tags (expected 1):`);
        console.error(block.trim().split('\n').slice(0, 4).join('\n'));
      }
    }
    if (badBlocks > 0) {
      console.error(`\n❌ FATAL: ${badBlocks} URL block(s) have invalid <lastmod> counts — aborting.`);
      process.exit(1);
    }
    console.log(`✅ Validated ${urlBlocks.length} URL blocks — each has exactly one <lastmod>`);

    fs.writeFileSync(path.join(publicFolder, 'sitemap.xml'), xml, 'utf8');
    console.log('✅ sitemap.xml generated');

    // 6. Sample
    console.log('\n📋 Sample URLs:');
    const sampleCount = Math.min(15, allUrls.length);
    for (let i = 0; i < sampleCount; i++) {
      console.log(`   - ${allUrls[i].loc} (priority: ${allUrls[i].priority})`);
    }
    if (allUrls.length > sampleCount) {
      console.log(`   ... and ${allUrls.length - sampleCount} more`);
    }

    // 7. robots.txt
    generateRobotsTxt();

    // 8. Summary
    console.log('\n📊 Sitemap Statistics:');
    console.log(`   Total URLs: ${allUrls.length}`);
    console.log(`   Static: ${staticResults.length}`);
    console.log(`   Dynamic Products: ${productResults.length}`);
    console.log(`   Dynamic Sellers: ${sellerResults.length}`);

  } catch (err) {
    console.error('❌ Sitemap error:', err);
    process.exit(1);
  }
}

generateSitemap();
