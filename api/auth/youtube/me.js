import { parseCookies, clearCookie } from '../../_lib/cookies.js';

// Returns connection state + channel info, or {connected:false}.
export default async function handler(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.yt_access_token;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

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
        return res.end(JSON.stringify({ connected: false, error: 'token expired or revoked' }));
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
