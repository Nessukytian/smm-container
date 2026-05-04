// Single dynamic-route handler for /api/auth/meta/{login|callback|me|disconnect}.
import { parseCookies, setCookie, clearCookie } from '../../_lib/cookies.js';
import { getAccessiblePages } from '../../_lib/meta-pages.js';

const META_VERSION = 'v21.0';
const REDIRECT_URI =
  process.env.META_REDIRECT_URI ||
  'https://smm-container.vercel.app/api/auth/meta/callback';

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
  const appId = process.env.META_APP_ID;
  if (!appId) return res.status(500).send('META_APP_ID env var is not set');

  const state = randomString(24);
  setCookie(res, 'meta_state', state, { maxAge: 600 });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  // Полный набор для Instagram + Facebook Pages publishing.
  const scope = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'instagram_basic',
    'instagram_content_publish',
  ].join(',');

  const url = new URL(`https://www.facebook.com/${META_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);

  res.statusCode = 302;
  res.setHeader('Location', url.toString());
  res.end();
}

async function doCallback(req, res) {
  const { code, state, error, error_description } = req.query || {};
  if (error) return redirectHome(res, { meta_error: error_description || error });
  if (!code || !state) return redirectHome(res, { meta_error: 'missing code or state' });

  const cookies = parseCookies(req);
  if (cookies.meta_state !== state) return redirectHome(res, { meta_error: 'state mismatch (csrf)' });
  clearCookie(res, 'meta_state');

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return redirectHome(res, { meta_error: 'META_APP_ID/SECRET not configured' });

  let tokens;
  try {
    const url = new URL(`https://graph.facebook.com/${META_VERSION}/oauth/access_token`);
    url.searchParams.set('client_id', appId);
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('code', code);
    const resp = await fetch(url.toString());
    tokens = await resp.json();
  } catch (e) {
    return redirectHome(res, { meta_error: 'token fetch failed: ' + (e.message || e) });
  }

  if (!tokens.access_token) {
    return redirectHome(res, { meta_error: tokens.error?.message || tokens.error || JSON.stringify(tokens) });
  }

  // Upgrade short-lived → long-lived (60 days)
  let longLived = tokens;
  try {
    const url = new URL(`https://graph.facebook.com/${META_VERSION}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('fb_exchange_token', tokens.access_token);
    const resp = await fetch(url.toString());
    const data = await resp.json();
    if (data.access_token) longLived = data;
  } catch (e) { /* fallback to short-lived */ }

  const accessToken = longLived.access_token || tokens.access_token;
  const accessMaxAge = Math.max(60, (longLived.expires_in || 60 * 60 * 24 * 60) - 60);

  setCookie(res, 'meta_access_token', accessToken, { maxAge: accessMaxAge });

  redirectHome(res, { meta: 'connected' });
}

async function doMe(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.meta_access_token;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (!token) return res.end(JSON.stringify({ connected: false }));

  // DEBUG MODE — returns raw FB API responses to diagnose Pages access issues
  if (req.query?.debug === '1') {
    const out = { token_length: token.length };
    try {
      // 1. Check what permissions/scopes the token has
      const debugUrl = new URL(`https://graph.facebook.com/${META_VERSION}/debug_token`);
      debugUrl.searchParams.set('input_token', token);
      debugUrl.searchParams.set('access_token',
        process.env.META_APP_ID + '|' + process.env.META_APP_SECRET);
      const dr = await fetch(debugUrl.toString());
      out.debug_token = await dr.json();
    } catch (e) { out.debug_token_error = e.message; }
    try {
      // 2. /me with all useful fields
      const meUrl = new URL(`https://graph.facebook.com/${META_VERSION}/me`);
      meUrl.searchParams.set('fields', 'id,name,email');
      meUrl.searchParams.set('access_token', token);
      const r = await fetch(meUrl.toString());
      out.me = await r.json();
    } catch (e) { out.me_error = e.message; }
    try {
      // 3. /me/accounts (Pages list) — the critical query
      const pagesUrl = new URL(`https://graph.facebook.com/${META_VERSION}/me/accounts`);
      pagesUrl.searchParams.set('fields',
        'id,name,access_token,instagram_business_account{id,username,name}');
      pagesUrl.searchParams.set('access_token', token);
      const r = await fetch(pagesUrl.toString());
      out.me_accounts = await r.json();
    } catch (e) { out.me_accounts_error = e.message; }
    try {
      // 4. Permissions granted to the token
      const permUrl = new URL(`https://graph.facebook.com/${META_VERSION}/me/permissions`);
      permUrl.searchParams.set('access_token', token);
      const r = await fetch(permUrl.toString());
      out.permissions = await r.json();
    } catch (e) { out.permissions_error = e.message; }
    return res.end(JSON.stringify(out, null, 2));
  }

  try {
    const meUrl = new URL(`https://graph.facebook.com/${META_VERSION}/me`);
    meUrl.searchParams.set('fields', 'name');
    meUrl.searchParams.set('access_token', token);
    const meResp = await fetch(meUrl.toString());
    const me = await meResp.json();

    if (me.error) {
      if (me.error.code === 190) {
        clearCookie(res, 'meta_access_token');
        return res.end(JSON.stringify({ connected: false, error: 'token expired or revoked' }));
      }
      return res.end(JSON.stringify({ connected: false, error: me.error.message || me.error }));
    }

    // Meta v21+ с granular scopes: /me/accounts может возвращать пусто.
    // Берём page IDs из granular_scopes в debug_token и опрашиваем по одной.
    const pages = await getAccessiblePages(token);

    return res.end(JSON.stringify({
      connected: true,
      name: me.name,
      pages,
      pages_count: pages.length,
      ig_accounts: pages.filter(p => p.instagram).map(p => p.instagram),
    }));
  } catch (e) {
    return res.end(JSON.stringify({ connected: false, error: 'network: ' + (e.message || e) }));
  }
}

function doDisconnect(req, res) {
  clearCookie(res, 'meta_access_token');
  clearCookie(res, 'meta_state');
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

