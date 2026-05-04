// Single dynamic-route handler for /api/auth/tiktok/{login|callback|me|disconnect}.
// Vercel Hobby plan limits us to 12 serverless functions; consolidating cuts 4→1.

import { parseCookies, setCookie, clearCookie } from '../../_lib/cookies.js';
import { getUserId, saveToken, getToken, deleteToken } from '../../_lib/sb.js';

const REDIRECT_URI =
  process.env.TIKTOK_REDIRECT_URI ||
  'https://smm-container.vercel.app/api/auth/tiktok/callback';

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
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(500).send('TIKTOK_CLIENT_KEY env var is not set');

  const state = randomString(24);
  setCookie(res, 'tt_state', state, { maxAge: 600 });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.searchParams.set('client_key', clientKey);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'user.info.basic,video.upload');
  url.searchParams.set('state', state);

  res.statusCode = 302;
  res.setHeader('Location', url.toString());
  res.end();
}

async function doCallback(req, res) {
  const { code, state, error, error_description } = req.query || {};
  if (error) return redirectHome(res, { tiktok_error: error_description || error });
  if (!code || !state) return redirectHome(res, { tiktok_error: 'missing code or state' });

  const cookies = parseCookies(req);
  if (cookies.tt_state !== state) return redirectHome(res, { tiktok_error: 'state mismatch (csrf)' });
  clearCookie(res, 'tt_state');

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret)
    return redirectHome(res, { tiktok_error: 'TIKTOK_CLIENT_KEY/SECRET not configured' });

  let tokens;
  try {
    const resp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({
        client_key: clientKey, client_secret: clientSecret,
        code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
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

  const accessMaxAge = Math.max(60, (tokens.expires_in || 86400) - 60);
  const refreshMaxAge = 60 * 60 * 24 * 365;

  setCookie(res, 'tt_access_token', tokens.access_token, { maxAge: accessMaxAge });
  if (tokens.refresh_token) setCookie(res, 'tt_refresh_token', tokens.refresh_token, { maxAge: refreshMaxAge });
  if (tokens.open_id) setCookie(res, 'tt_open_id', tokens.open_id, { maxAge: refreshMaxAge });
  if (tokens.scope) setCookie(res, 'tt_scope', tokens.scope, { maxAge: refreshMaxAge });

  // Also persist in DB if user is signed in to Supabase (cross-device)
  const userId = await getUserId(req);
  if (userId) {
    await saveToken(userId, 'tiktok', {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
      metadata: { open_id: tokens.open_id, scope: tokens.scope },
    });
  }

  redirectHome(res, { tiktok: 'connected' });
}

async function doMe(req, res) {
  const cookies = parseCookies(req);
  let token = cookies.tt_access_token;
  let grantedScope = cookies.tt_scope || null;
  let openId = cookies.tt_open_id || null;

  // Cross-device fallback: pull token from DB if cookies are empty
  if (!token) {
    const userId = await getUserId(req);
    if (userId) {
      const dbToken = await getToken(userId, 'tiktok');
      if (dbToken) {
        token = dbToken.access_token;
        grantedScope = dbToken.metadata?.scope || grantedScope;
        openId = dbToken.metadata?.open_id || openId;
        // Restore cookie so subsequent requests are fast
        setCookie(res, 'tt_access_token', token, { maxAge: 86400 });
        if (openId) setCookie(res, 'tt_open_id', openId, { maxAge: 86400 });
      }
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.query?.debug === '1') {
    return res.end(JSON.stringify({
      has_access_token: !!token,
      access_token_length: token ? token.length : 0,
      granted_scope: grantedScope,
      open_id: openId,
    }, null, 2));
  }

  if (!token) return res.end(JSON.stringify({ connected: false }));

  try {
    const resp = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await resp.json();

    if (data?.error?.code && data.error.code !== 'ok') {
      if (data.error.code === 'access_token_invalid' || data.error.code === 'token_expired') {
        clearCookie(res, 'tt_access_token');
        clearCookie(res, 'tt_open_id');
      }
      return res.end(JSON.stringify({ connected: false, error: data.error.message || data.error.code }));
    }

    const user = data?.data?.user || {};
    return res.end(JSON.stringify({
      connected: true,
      open_id: user.open_id,
      display_name: user.display_name,
      username: user.username,
      avatar_url: user.avatar_url,
    }));
  } catch (e) {
    return res.end(JSON.stringify({ connected: false, error: 'network: ' + (e.message || e) }));
  }
}

async function doDisconnect(req, res) {
  clearCookie(res, 'tt_access_token');
  clearCookie(res, 'tt_refresh_token');
  clearCookie(res, 'tt_open_id');
  clearCookie(res, 'tt_scope');
  // Also delete from DB
  const userId = await getUserId(req);
  if (userId) await deleteToken(userId, 'tiktok');
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
