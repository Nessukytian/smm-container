import { clearCookie } from '../../_lib/cookies.js';

export default function handler(req, res) {
  clearCookie(res, 'meta_access_token');
  clearCookie(res, 'meta_state');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}
