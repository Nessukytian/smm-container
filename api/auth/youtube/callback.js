import { parseCookies, setCookie, clearCookie } from '../../_lib/cookies.js';

// Step 2 of YouTube OAuth — receive `code`, exchange for tokens, store in cookies.
export default async function handler(req, res) {
  const { code, state, error, error_description } = req.query || {};

  if (error) return redirectHome(res, { youtube_error: error_description || error });
  if (!code || !state) return redirectHome(res, { youtube_error: 'missing code or state' });

  const cookies = parseCookies(req);
  if (cookies.yt_state !== state) return redirectHome(res, { youtube_error: 'state mismatch (csrf)' });
  clearCookie(res, 'yt_state');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.YOUTUBE_REDIRECT_URI ||
    'https://smm-container.vercel.app/api/auth/youtube/callback';

  if (!clientId || !clientSecret) {
    return redirectHome(res, { youtube_error: 'GOOGLE_CLIENT_ID/SECRET not configured' });
  }

  let tokens;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    tokens = await resp.json();
  } catch (e) {
    return redirectHome(res, { youtube_error: 'token fetch failed: ' + (e.message || e) });
  }

  if (!tokens.access_token) {
    return redirectHome(res, {
      youtube_error: tokens.error_description || tokens.error || JSON.stringify(tokens),
    });
  }

  const accessMaxAge = Math.max(60, (tokens.expires_in || 3600) - 60);
  const refreshMaxAge = 60 * 60 * 24 * 365;

  setCookie(res, 'yt_access_token', tokens.access_token, { maxAge: accessMaxAge });
  if (tokens.refresh_token) {
    setCookie(res, 'yt_refresh_token', tokens.refresh_token, { maxAge: refreshMaxAge });
  }
  if (tokens.scope) {
    setCookie(res, 'yt_scope', tokens.scope, { maxAge: refreshMaxAge });
  }

  redirectHome(res, { youtube: 'connected' });
}

function redirectHome(res, params) {
  const q = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader('Location', '/' + (q ? '?' + q : ''));
  res.end();
}
