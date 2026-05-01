import { parseCookies, clearCookie } from '../../_lib/cookies.js';

// Returns Meta connection state + user info + list of Pages with linked IG accounts.
export default async function handler(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.meta_access_token;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (!token) return res.end(JSON.stringify({ connected: false }));

  try {
    // Basic user info
    const meUrl = new URL('https://graph.facebook.com/v21.0/me');
    meUrl.searchParams.set('fields', 'name');
    meUrl.searchParams.set('access_token', token);
    const meResp = await fetch(meUrl.toString());
    const me = await meResp.json();

    if (me.error) {
      // 190 = OAuthException (token invalid/expired)
      if (me.error.code === 190) {
        clearCookie(res, 'meta_access_token');
        return res.end(JSON.stringify({ connected: false, error: 'token expired or revoked' }));
      }
      return res.end(JSON.stringify({ connected: false, error: me.error.message || me.error }));
    }

    // List Pages user manages, with linked IG Business Account
    const pagesUrl = new URL('https://graph.facebook.com/v21.0/me/accounts');
    pagesUrl.searchParams.set(
      'fields',
      'name,id,access_token,instagram_business_account{id,username,name,profile_picture_url}'
    );
    pagesUrl.searchParams.set('access_token', token);
    const pagesResp = await fetch(pagesUrl.toString());
    const pagesData = await pagesResp.json();

    const pages = (pagesData.data || []).map(p => ({
      id: p.id,
      name: p.name,
      // page-specific access token (used for publishing to that Page)
      page_access_token: p.access_token,
      instagram: p.instagram_business_account ? {
        id: p.instagram_business_account.id,
        username: p.instagram_business_account.username,
        name: p.instagram_business_account.name,
        avatar: p.instagram_business_account.profile_picture_url,
      } : null,
    }));

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
