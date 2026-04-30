import { setCookie } from '../../_lib/cookies.js';

// Step 1 of OAuth — redirect the user to TikTok's authorization screen.
// TikTok will eventually call our /callback endpoint with a `code`.
export default function handler(req, res) {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUri =
    process.env.TIKTOK_REDIRECT_URI ||
    'https://smm-container.vercel.app/api/auth/tiktok/callback';

  if (!clientKey) {
    return res.status(500).send('TIKTOK_CLIENT_KEY env var is not set');
  }

  // CSRF state — generated, stored in a short-lived cookie, checked on return.
  const state = randomString(24);
  setCookie(res, 'tt_state', state, { maxAge: 600 });

  const scope = 'user.info.basic,video.upload';

  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.searchParams.set('client_key', clientKey);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);

  res.statusCode = 302;
  res.setHeader('Location', url.toString());
  res.end();
}

function randomString(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
