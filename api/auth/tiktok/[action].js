// Single dynamic-route handler for /api/auth/tiktok/{login|callback|me|disconnect}.
// Per-profile: ?profile=creative|personal — два независимых слота.
// Cookies: tt_access_token_<profile>, DB: provider='tiktok_<profile>'.

import { parseCookies, setCookie, clearCookie } from '../../_lib/cookies.js';
import { getUserId, saveToken, getToken, deleteToken } from '../../_lib/sb.js';

const REDIRECT_URI =
  process.env.TIKTOK_REDIRECT_URI ||
  'https://smm-container.vercel.app/api/auth/tiktok/callback';

const PROFILES = ['creative', 'personal'];
const cleanProfile = (p) => (PROFILES.includes(p) ? p : 'creative');
const cookieKey = (kind, profile) => `tt_${kind}_${profile}`;
const dbProvider = (profile) => `tiktok_${profile}`;

export default async function handler(req, res) {
  const action = String(req.query.action || '').toLowerCase();
  switch (action) {
    case 'login': return doLogin(req, res);
    case 'callback': return doCallback(req, res);
    case 'me': return doMe(req, res);
    case 'stats': return doStats(req, res);
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

  const profile = cleanProfile(req.query?.profile);
  const state = randomString(24);
  // храним state и target-profile в cookies на 10 минут
  setCookie(res, 'tt_state', state, { maxAge: 600 });
  setCookie(res, 'tt_login_profile', profile, { maxAge: 600 });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.searchParams.set('client_key', clientKey);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'user.info.basic,user.info.stats,video.upload');
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
  const profile = cleanProfile(cookies.tt_login_profile);
  clearCookie(res, 'tt_state');
  clearCookie(res, 'tt_login_profile');

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

  setCookie(res, cookieKey('access_token', profile), tokens.access_token, { maxAge: accessMaxAge });
  if (tokens.refresh_token) setCookie(res, cookieKey('refresh_token', profile), tokens.refresh_token, { maxAge: refreshMaxAge });
  if (tokens.open_id) setCookie(res, cookieKey('open_id', profile), tokens.open_id, { maxAge: refreshMaxAge });
  if (tokens.scope) setCookie(res, cookieKey('scope', profile), tokens.scope, { maxAge: refreshMaxAge });

  // Persist in DB if user is signed in to Supabase (cross-device)
  const userId = await getUserId(req);
  if (userId) {
    await saveToken(userId, dbProvider(profile), {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
      metadata: { open_id: tokens.open_id, scope: tokens.scope },
    });
  }

  redirectHome(res, { tiktok: 'connected', profile });
}

// Достать токен для конкретного профиля (cookie → DB fallback).
async function getProfileToken(req, res, profile) {
  const cookies = parseCookies(req);
  let token = cookies[cookieKey('access_token', profile)];
  let scope = cookies[cookieKey('scope', profile)] || null;
  let openId = cookies[cookieKey('open_id', profile)] || null;
  if (!token) {
    const userId = await getUserId(req);
    if (userId) {
      const dbToken = await getToken(userId, dbProvider(profile));
      if (dbToken) {
        token = dbToken.access_token;
        scope = dbToken.metadata?.scope || scope;
        openId = dbToken.metadata?.open_id || openId;
        if (res) {
          setCookie(res, cookieKey('access_token', profile), token, { maxAge: 86400 });
          if (openId) setCookie(res, cookieKey('open_id', profile), openId, { maxAge: 86400 });
        }
      }
    }
  }
  return { token, scope, openId };
}

async function doMe(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Если ?profile= указан — отдать только его. Иначе — оба сразу.
  const requested = req.query?.profile;
  const profiles = requested ? [cleanProfile(requested)] : PROFILES;

  const out = {};
  for (const profile of profiles) {
    const { token, openId } = await getProfileToken(req, res, profile);
    if (!token) { out[profile] = { connected: false }; continue; }
    try {
      const resp = await fetch(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await resp.json();
      if (data?.error?.code && data.error.code !== 'ok') {
        if (data.error.code === 'access_token_invalid' || data.error.code === 'token_expired') {
          clearCookie(res, cookieKey('access_token', profile));
          clearCookie(res, cookieKey('open_id', profile));
        }
        out[profile] = { connected: false, error: data.error.message || data.error.code };
        continue;
      }
      const user = data?.data?.user || {};
      out[profile] = {
        connected: true,
        open_id: user.open_id,
        display_name: user.display_name,
        username: user.username,
        avatar_url: user.avatar_url,
      };
    } catch (e) {
      out[profile] = { connected: false, error: 'network: ' + (e.message || e) };
    }
  }

  // Обратная совместимость: если был ?profile= — вернуть плоский объект (как было раньше).
  if (requested) return res.end(JSON.stringify(out[cleanProfile(requested)]));
  return res.end(JSON.stringify(out));
}

// Returns TT stats per profile: followers, likes, video_count, etc. (нужен user.info.stats scope)
async function doStats(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const requested = req.query?.profile;
  const profiles = requested ? [cleanProfile(requested)] : PROFILES;

  const out = {};
  for (const profile of profiles) {
    const { token } = await getProfileToken(req, res, profile);
    if (!token) { out[profile] = { connected: false }; continue; }
    try {
      const fields = 'open_id,display_name,avatar_url,follower_count,following_count,likes_count,video_count';
      const resp = await fetch(
        `https://open.tiktokapis.com/v2/user/info/?fields=${fields}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await resp.json();
      if (data?.error?.code && data.error.code !== 'ok') {
        out[profile] = { connected: false, error: data.error.message || data.error.code };
        continue;
      }
      const u = data?.data?.user || {};
      out[profile] = {
        connected: true,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        follower_count: u.follower_count,
        following_count: u.following_count,
        likes_count: u.likes_count,
        video_count: u.video_count,
      };
    } catch (e) {
      out[profile] = { connected: false, error: 'network: ' + (e.message || e) };
    }
  }

  if (requested) return res.end(JSON.stringify({ ok: true, ...out[cleanProfile(requested)] }));
  return res.end(JSON.stringify({ ok: true, ...out }));
}

async function doDisconnect(req, res) {
  const profile = cleanProfile(req.query?.profile);
  clearCookie(res, cookieKey('access_token', profile));
  clearCookie(res, cookieKey('refresh_token', profile));
  clearCookie(res, cookieKey('open_id', profile));
  clearCookie(res, cookieKey('scope', profile));
  const userId = await getUserId(req);
  if (userId) await deleteToken(userId, dbProvider(profile));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, profile }));
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
