import { setCookie } from '../../_lib/cookies.js';

// Step 1 — redirect user to Facebook OAuth.
// One Meta OAuth gives access to user's FB Pages + linked Instagram Business accounts.
export default function handler(req, res) {
  const appId = process.env.META_APP_ID;
  const redirectUri =
    process.env.META_REDIRECT_URI ||
    'https://smm-container.vercel.app/api/auth/meta/callback';

  if (!appId) {
    return res.status(500).send('META_APP_ID env var is not set');
  }

  const state = randomString(24);
  setCookie(res, 'meta_state', state, { maxAge: 600 });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  // Scopes for Instagram + Facebook publishing.
  // - pages_show_list / pages_read_engagement: list user's pages
  // - pages_manage_posts: publish to FB Page
  // - instagram_basic: read IG business account info
  // - instagram_content_publish: publish to IG
  const scope = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'instagram_basic',
    'instagram_content_publish',
  ].join(',');

  const url = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  url.searchParams.set('client_id', appId);
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
