// Tiny cookie helpers for serverless functions.
// We avoid extra deps so Vercel can run this with zero install.

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(val);
  });
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  appendSetCookie(res, parts.join('; '));
}

export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

function appendSetCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', value);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, value]);
  else res.setHeader('Set-Cookie', [prev, value]);
}
