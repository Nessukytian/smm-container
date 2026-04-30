import { parseCookies, setCookie, clearCookie } from '../../_lib/cookies.js';

// Step 2 of OAuth — receive the `code`, exchange it for an access_token,
// store the token in HTTP-only cookies, then bounce the user back to the app.
export default async function handler(req, res) {
  const { code, state, error, error_description } = req.query || {};

  if (error) {
    return redirectHome(res, { tiktok_error: error_description || error });
  }
  if (!code || !state) {
    return redirectHome(res, { tiktok_error: 'missing code or state' });
  }

  const cookies = parseCookies(req);
  if (cookies.tt_state !== state) {
    return redirectHome(res, { tiktok_error: 'state mismatch (csrf)' });
  }
  clearCookie(res, 'tt_state');

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri =
    process.env.TIKTOK_REDIRECT_URI ||
    'https://smm-container.vercel.app/api/auth/tiktok/callback';

  if (!clientKey || !clientSecret) {
    return redirectHome(res, { tiktok_error: 'TIKTOK_CLIENT_KEY/SECRET not configured' });
  }

  let tokens;
  try {
    const resp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    tokens = await resp.json();
  } catch (e) {
    return redirectHome(res, { tiktok_error: 'token fetch failed: ' + (e.message || e) });
  }

  if (!tokens.access_token) {
    return redirectHome(res, {
      tiktok_error: tokens.error_description || tokens.error || JSON.stringify(tokens),
    });
  }

  // Persist for ~the lifetime of the access token; refresh later if we need to.
  const accessMaxAge = Math.max(60, (tokens.expires_in || 86400) - 60);
  const refreshMaxAge = 60 * 60 * 24 * 365; // 1 year

  setCookie(res, 'tt_access_token', tokens.access_token, { maxAge: accessMaxAge });
  if (tokens.refresh_token) {
    setCookie(res, 'tt_refresh_token', tokens.refresh_token, { maxAge: refreshMaxAge });
  }
  if (tokens.open_id) {
    setCookie(res, 'tt_open_id', tokens.open_id, { maxAge: refreshMaxAge });
  }
  if (tokens.scope) {
    setCookie(res, 'tt_scope', tokens.scope, { maxAge: refreshMaxAge });
  }

  redirectHome(res, { tiktok: 'connected' });
}

function redirectHome(res, params) {
  const q = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader('Location', '/' + (q ? '?' + q : ''));
  res.end();
}
