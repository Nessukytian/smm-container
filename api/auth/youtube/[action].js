// Single dynamic-route handler for /api/auth/youtube/{login|callback|me|disconnect}.
import { parseCookies, setCookie, clearCookie } from '../../_lib/cookies.js';
import { getUserId, saveToken, getToken, deleteToken } from '../../_lib/sb.js';

const REDIRECT_URI =
  process.env.YOUTUBE_REDIRECT_URI ||
  'https://smm-container.vercel.app/api/auth/youtube/callback';

export default async function handler(req, res) {
  const action = String(req.query.action || '').toLowerCase();
  switch (action) {
    case 'login': return doLogin(req, res);
    case 'callback': return doCallback(req, res);
    case 'me': return doMe(req, res);
    case 'disconnect': return doDisconnect(req, res);
    default:
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'unknown action: ' + action }));
  }
}

function doLogin(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).send('GOOGLE_CLIENT_ID env var is not set');

  const state = randomString(24);
  setCookie(res, 'yt_state', state, { maxAge: 600 });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const scope = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ].join(' ');

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');

  res.statusCode = 302;
  res.setHeader('Location', url.toString());
  res.end();
}

async function doCallback(req, res) {
  const { code, state, error, error_description } = req.query || {};
  if (error) return redirectHome(res, { youtube_error: error_description || error });
  if (!code || !state) return redirectHome(res, { youtube_error: 'missing code or state' });

  const cookies = parseCookies(req);
  if (cookies.yt_state !== state) return redirectHome(res, { youtube_error: 'state mismatch (csrf)' });
  clearCookie(res, 'yt_state');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    return redirectHome(res, { youtube_error: 'GOOGLE_CLIENT_ID/SECRET not configured' });

  let tokens;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
      }),
    });
    tokens = await resp.json();
  } catch (e) {
    return redirectHome(res, { youtube_error: 'token fetch failed: ' + (e.message || e) });
  }

  if (!tokens.access_token) {
    return redirectHome(res, {
      youtube_error: tokens.error_description || tokens.error || 'no token',
    });
  }

  const accessMaxAge = Math.max(60, (tokens.expires_in || 3600) - 60);
  const refreshMaxAge = 60 * 60 * 24 * 365;

  setCookie(res, 'yt_access_token', tokens.access_token, { maxAge: accessMaxAge });
  if (tokens.refresh_token) setCookie(res, 'yt_refresh_token', tokens.refresh_token, { maxAge: refreshMaxAge });
  if (tokens.scope) setCookie(res, 'yt_scope', tokens.scope, { maxAge: refreshMaxAge });

  // Persist in DB if user is signed in
  const userId = await getUserId(req);
  if (userId) {
    await saveToken(userId, 'youtube', {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
      metadata: { scope: tokens.scope },
    });
  }

  redirectHome(res, { youtube: 'connected' });
}

async function doMe(req, res) {
  const cookies = parseCookies(req);
  let token = cookies.yt_access_token;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  // Cross-device fallback: pull from DB
  if (!token) {
    const userId = await getUserId(req);
    if (userId) {
      const dbToken = await getToken(userId, 'youtube');
      if (dbToken) {
        token = dbToken.access_token;
        setCookie(res, 'yt_access_token', token, { maxAge: 3600 });
      }
    }
  }

  if (!token) return res.end(JSON.stringify({ connected: false }));

  try {
    const resp = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await resp.json();

    if (data.error) {
      if (data.error.code === 401) {
        clearCookie(res, 'yt_access_token');
        return res.end(JSON.stringify({ connected: false, error: 'token expired' }));
      }
      return res.end(JSON.stringify({ connected: false, error: data.error.message || data.error }));
    }

    const ch = data.items?.[0];
    if (!ch) return res.end(JSON.stringify({ connected: false, error: 'no channel found' }));

    return res.end(JSON.stringify({
      connected: true,
      channel_id: ch.id,
      title: ch.snippet?.title,
      thumbnail: ch.snippet?.thumbnails?.default?.url,
      subscriber_count: ch.statistics?.subscriberCount,
    }));
  } catch (e) {
    return res.end(JSON.stringify({ connected: false, error: 'network: ' + (e.message || e) }));
  }
}

async function doDisconnect(req, res) {
  clearCookie(res, 'yt_access_token');
  clearCookie(res, 'yt_refresh_token');
  clearCookie(res, 'yt_scope');
  const userId = await getUserId(req);
  if (userId) await deleteToken(userId, 'youtube');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}

function redirectHome(res, params) {
  const q = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader('Location', '/' + (q ? '?' + q : ''));
  res.end();
}

function randomString(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
