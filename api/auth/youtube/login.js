import { setCookie } from '../../_lib/cookies.js';

// Step 1 of YouTube OAuth — redirect user to Google's authorization screen.
export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri =
    process.env.YOUTUBE_REDIRECT_URI ||
    'https://smm-container.vercel.app/api/auth/youtube/callback';

  if (!clientId) {
    return res.status(500).send('GOOGLE_CLIENT_ID env var is not set');
  }

  const state = randomString(24);
  setCookie(res, 'yt_state', state, { maxAge: 600 });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  // Scopes needed:
  //   - youtube.upload — upload videos to user's channel
  //   - youtube.readonly — read channel info (for "@channel" display)
  const scope = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ].join(' ');

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  // access_type=offline + prompt=consent → ensure we get refresh_token on every login
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');

  res.statusCode = 302;
  res.setHeader('Location', url.toString());
  res.end();
}

function randomString(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
