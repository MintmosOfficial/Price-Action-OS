// Vercel serverless function (ES module, works regardless of package.json "type").
// Environment variables: FIREBASE_SERVICE_ACCOUNT, WHOP_API_KEY, WHOP_PRODUCT_ID (recommended).
import crypto from 'node:crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const NOT_FOUND = 'That license key was not found. Copy it exactly from your Whop purchase.';
const OK_STATUS = ['active', 'trialing', 'completed'];

export default async function handler(req, res) {
  const fail = (status, error) => res.status(status).json({ error });
  if (req.method !== 'POST') return fail(405, 'Method not allowed.');
  try {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });

    const b = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!b) return fail(401, 'Please sign in again.');
    let user;
    try { user = await getAuth().verifyIdToken(b[1]); } catch (e) { return fail(401, 'Please sign in again.'); }
    const verified = user.email_verified || (user.firebase && user.firebase.sign_in_provider !== 'password');
    if (!user.email || !verified) return fail(403, 'Please verify your email first.');

    const key = String((req.body && req.body.key) || '').trim();
    if (key.length < 10 || key.length > 80) return fail(400, NOT_FOUND);

    const r = await fetch('https://api.whop.com/api/v1/memberships/' + encodeURIComponent(key), {
      headers: { Authorization: 'Bearer ' + process.env.WHOP_API_KEY, 'Api-Version-Date': process.env.WHOP_API_VERSION || '2026-08-21-1' }
    });
    if (r.status === 404) return fail(400, NOT_FOUND);
    if (!r.ok) { console.error('Whop API error', r.status, await r.text().catch(() => '')); return fail(500, 'Setup error on our side. Please contact support.'); }
    const m = await r.json().catch(() => ({}));

    // The pasted text must be the real license key (a membership ID like mem_xxx is not accepted).
    if (!m.license_key || String(m.license_key).toUpperCase() !== key.toUpperCase()) return fail(400, NOT_FOUND);
    const pid = (m.product && (m.product.id || m.product)) || m.product_id;
    if (process.env.WHOP_PRODUCT_ID && pid && pid !== process.env.WHOP_PRODUCT_ID) return fail(400, NOT_FOUND);
    const ok = m.valid !== false && (m.valid === true || OK_STATUS.includes(m.status));
    if (!ok) { console.error('Membership not active:', m.status, m.valid); return fail(403, 'This purchase is not active (status: ' + (m.status || 'unknown') + '), so access is not available.'); }

    const db = getFirestore();
    const id = crypto.createHash('sha256').update(key.toUpperCase()).digest('hex');
    const kref = db.collection('license_keys').doc(id), mref = db.collection('members').doc(user.uid);
    const email = user.email.toLowerCase();
    const out = await db.runTransaction(async (t) => {
      const s = await t.get(kref);
      if (s.exists && s.data().uid !== user.uid) return 'taken';
      if (!s.exists) t.set(kref, { uid: user.uid, email, at: Date.now() });
      t.set(mref, { email, code: 'whop', joined: Date.now() }, { merge: true });
      return 'ok';
    });
    if (out === 'taken') return fail(409, 'That key is already linked to another account. Contact support if it is yours.');
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('redeem error:', e);
    return fail(500, 'Setup error on our side. Please contact support.');
  }
}
