export default function handler(req, res) {
  const ck = process.env.TIKTOK_CLIENT_KEY || '';
  const cs = process.env.TIKTOK_CLIENT_SECRET || '';
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    TIKTOK_CLIENT_KEY: { present: !!ck, length: ck.length, prefix: ck.slice(0,4), suffix: ck.slice(-3), has_whitespace_around: ck !== ck.trim() },
    TIKTOK_CLIENT_SECRET: { present: !!cs, length: cs.length, has_whitespace_around: cs !== cs.trim() },
    node: process.version,
    region: process.env.VERCEL_REGION || null,
    env: process.env.VERCEL_ENV || null
  }, null, 2));
}
