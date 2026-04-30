import { clearCookie } from '../../_lib/cookies.js';

export default function handler(req, res) {
  clearCookie(res, 'tt_access_token');
  clearCookie(res, 'tt_refresh_token');
  clearCookie(res, 'tt_open_id');
  clearCookie(res, 'tt_scope');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}
