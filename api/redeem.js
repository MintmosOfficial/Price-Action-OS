// Vercel serverless function: turns a valid Gumroad license key into a course membership.
// Needs two Vercel environment variables: FIREBASE_SERVICE_ACCOUNT and GUMROAD_PRODUCT_ID.
const crypto = require('crypto');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const NOT_FOUND = 'That license key was not found. Copy it exactly from your Gumroad receipt.';

module.exports = async (req, res) => {
  const fail = (status, error) => res.status(status).json({ error });
  if (req.method !== 'POST') return fail(405, 'Method not allowed.');
  try {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });

    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return fail(401, 'Please sign in again.');
    let user;
    try { user = await getAuth().verifyIdToken(m[1]); } catch (e) { return fail(401, 'Please sign in again.'); }
    const verified = user.email_verified || (user.firebase && user.firebase.sign_in_provider !== 'password');
    if (!user.email || !verified) return fail(403, 'Please verify your email first.');

    const key = String((req.body && req.body.key) || '').trim();
    if (key.length < 10 || key.length > 80) return fail(400, NOT_FOUND);

    const g = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ product_id: process.env.GUMROAD_PRODUCT_ID, license_key: key, increment_uses_count: 'false' })
    });
    const d = await g.json().catch(() => ({}));
    if (!d.success) return fail(400, NOT_FOUND);
    const p = d.purchase || {};
    if (p.refunded || p.chargebacked || (p.disputed && !p.dispute_won))
      return fail(403, 'This purchase was refunded or disputed, so access is not available.');

    const db = getFirestore();
    const id = crypto.createHash('sha256').update(key.toUpperCase()).digest('hex');
    const kref = db.collection('gumroad_keys').doc(id), mref = db.collection('members').doc(user.uid);
    const email = user.email.toLowerCase();
    const out = await db.runTransaction(async (t) => {
      const s = await t.get(kref);
      if (s.exists && s.data().uid !== user.uid) return 'taken';
      if (!s.exists) t.set(kref, { uid: user.uid, email, buyer: p.email || null, at: Date.now() });
      t.set(mref, { email, code: 'gumroad', joined: Date.now() }, { merge: true });
      return 'ok';
    });
    if (out === 'taken') return fail(409, 'That key is already linked to another account. Contact support if it is yours.');
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('redeem error:', e);
    return fail(500, 'Setup error on our side. Please contact support.');
  }
};
