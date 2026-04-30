import { parseCookies, clearCookie } from '../../_lib/cookies.js';

// Returns basic info about the connected TikTok account, or {connected:false}.
// The frontend calls this on load to know whether to show "Connect" vs "Connected as @x".
export default async function handler(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.tt_access_token;
  const grantedScope = cookies.tt_scope || null;
  const openId = cookies.tt_open_id || null;

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Debug mode: return what we have without calling the API
  if (req.query?.debug === '1') {
    return res.end(
      JSON.stringify({
        has_access_token: !!token,
        access_token_length: token ? token.length : 0,
        granted_scope: grantedScope,
        open_id: openId,
      }, null, 2)
    );
  }

  if (!token) {
    return res.end(JSON.stringify({ connected: false }));
  }

  try {
    const resp = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    const data = await resp.json();

    if (data?.error?.code && data.error.code !== 'ok') {
      // Token expired or revoked — clear it so the UI shows "Connect" again.
      if (data.error.code === 'access_token_invalid' || data.error.code === 'token_expired') {
        clearCookie(res, 'tt_access_token');
        clearCookie(res, 'tt_open_id');
      }
      return res.end(
        JSON.stringify({
          connected: false,
          error: data.error.message || data.error.code,
        })
      );
    }

    const user = data?.data?.user || {};
    return res.end(
      JSON.stringify({
        connected: true,
        open_id: user.open_id,
        display_name: user.display_name,
        username: user.username,
        avatar_url: user.avatar_url,
      })
    );
  } catch (e) {
    return res.end(
      JSON.stringify({ connected: false, error: 'network: ' + (e.message || e) })
    );
  }
}
