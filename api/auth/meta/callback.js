import { parseCookies, setCookie, clearCookie } from '../../_lib/cookies.js';

// Step 2 — exchange code for token, then short-lived → long-lived (60d).
export default async function handler(req, res) {
  const { code, state, error, error_description } = req.query || {};

  if (error) return redirectHome(res, { meta_error: error_description || error });
  if (!code || !state) return redirectHome(res, { meta_error: 'missing code or state' });

  const cookies = parseCookies(req);
  if (cookies.meta_state !== state) return redirectHome(res, { meta_error: 'state mismatch (csrf)' });
  clearCookie(res, 'meta_state');

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri =
    process.env.META_REDIRECT_URI ||
    'https://smm-container.vercel.app/api/auth/meta/callback';

  if (!appId || !appSecret) {
    return redirectHome(res, { meta_error: 'META_APP_ID/SECRET not configured' });
  }

  // 1) Exchange code → short-lived token
  let tokens;
  try {
    const url = new URL('https://graph.facebook.com/v21.0/oauth/access_token');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code', code);
    const resp = await fetch(url.toString());
    tokens = await resp.json();
  } catch (e) {
    return redirectHome(res, { meta_error: 'token fetch failed: ' + (e.message || e) });
  }

  if (!tokens.access_token) {
    return redirectHome(res, {
      meta_error: tokens.error?.message || tokens.error || JSON.stringify(tokens),
    });
  }

  // 2) Upgrade to long-lived (60 days)
  let longLived = tokens;
  try {
    const url = new URL('https://graph.facebook.com/v21.0/oauth/access_token');
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('fb_exchange_token', tokens.access_token);
    const resp = await fetch(url.toString());
    const data = await resp.json();
    if (data.access_token) longLived = data;
  } catch (e) { /* ignore — fallback to short-lived */ }

  const accessToken = longLived.access_token || tokens.access_token;
  const accessMaxAge = Math.max(60, (longLived.expires_in || 60 * 60 * 24 * 60) - 60);

  setCookie(res, 'meta_access_token', accessToken, { maxAge: accessMaxAge });

  redirectHome(res, { meta: 'connected' });
}

function redirectHome(res, params) {
  const q = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader('Location', '/' + (q ? '?' + q : ''));
  res.end();
}
