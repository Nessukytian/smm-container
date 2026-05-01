import { clearCookie } from '../../_lib/cookies.js';

export default function handler(req, res) {
  clearCookie(res, 'yt_access_token');
  clearCookie(res, 'yt_refresh_token');
  clearCookie(res, 'yt_scope');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}
