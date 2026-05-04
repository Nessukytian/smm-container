// Helper for fetching the user's Pages with linked Instagram Business accounts.
// Meta v21+ with granular scopes returns empty /me/accounts — we need to extract
// page IDs from debug_token's granular_scopes and query each Page individually.

const META_VERSION = 'v21.0';

export async function getAccessiblePages(userToken) {
  const debugUrl = new URL(`https://graph.facebook.com/${META_VERSION}/debug_token`);
  debugUrl.searchParams.set('input_token', userToken);
  debugUrl.searchParams.set(
    'access_token',
    `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
  );

  let pageIds = [];
  try {
    const r = await fetch(debugUrl.toString());
    const data = await r.json();
    const granular = data?.data?.granular_scopes || [];
    const showList = granular.find(s => s.scope === 'pages_show_list');
    pageIds = showList?.target_ids || [];
  } catch (e) {
    return [];
  }
  if (pageIds.length === 0) return [];

  const pages = await Promise.all(pageIds.map(async pid => {
    try {
      const url = new URL(`https://graph.facebook.com/${META_VERSION}/${pid}`);
      url.searchParams.set(
        'fields',
        'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}'
      );
      url.searchParams.set('access_token', userToken);
      const r = await fetch(url.toString());
      const p = await r.json();
      if (p.error) return null;
      return {
        id: p.id,
        name: p.name,
        page_access_token: p.access_token,
        instagram: p.instagram_business_account ? {
          id: p.instagram_business_account.id,
          username: p.instagram_business_account.username,
          name: p.instagram_business_account.name,
          avatar: p.instagram_business_account.profile_picture_url,
        } : null,
      };
    } catch (e) { return null; }
  }));

  return pages.filter(Boolean);
}
