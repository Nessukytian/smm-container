import { parseCookies } from '../_lib/cookies.js';
import { getUserId, getToken } from '../_lib/sb.js';

// Upload a video to user's YouTube channel via Data API v3 (multipart upload).
// Frontend sends JSON: { video_base64, title, description, privacy }
// Vercel body limit (Hobby) is 4.5MB — we use 5MB cap for safety.

export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: 'POST only' }));
  }

  const cookies = parseCookies(req);
  let token = cookies.yt_access_token;
  if (!token) {
    const userId = await getUserId(req);
    if (userId) {
      const dbToken = await getToken(userId, 'youtube');
      if (dbToken) token = dbToken.access_token;
    }
  }
  if (!token) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: 'not connected to YouTube' }));
  }

  const { video_base64, title, description, privacy, tags } = req.body || {};
  if (!video_base64) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'video_base64 missing' }));
  }

  let videoBytes;
  try { videoBytes = Buffer.from(video_base64, 'base64'); } catch (e) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'bad base64' }));
  }
  if (videoBytes.length === 0) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'empty video' }));
  }

  const metadata = {
    snippet: {
      title: String(title || 'Untitled').slice(0, 100),
      description: String(description || '').slice(0, 5000),
      tags: Array.isArray(tags) ? tags.slice(0, 30) : undefined,
      categoryId: '22', // People & Blogs (broadest applicability)
    },
    status: {
      privacyStatus: ['private', 'unlisted', 'public'].includes(privacy) ? privacy : 'private',
      selfDeclaredMadeForKids: false,
    },
  };

  // Build multipart/related body manually (Vercel's runtime supports Buffer just fine).
  const boundary = 'studio-' + Math.random().toString(36).slice(2, 14);
  const meta = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    'utf-8'
  );
  const videoHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: video/*\r\n\r\n`,
    'utf-8'
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const body = Buffer.concat([meta, videoHeader, videoBytes, closing]);

  let result;
  try {
    const resp = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      }
    );
    result = await resp.json();

    if (!resp.ok || result.error) {
      res.statusCode = 502;
      return res.end(JSON.stringify({
        ok: false,
        error: result.error?.message || `HTTP ${resp.status}`,
        code: result.error?.code,
        details: result,
      }));
    }
  } catch (e) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
  }

  return res.end(JSON.stringify({
    ok: true,
    video_id: result.id,
    url: `https://www.youtube.com/watch?v=${result.id}`,
    privacy: result.status?.privacyStatus,
    message: 'Видео загружено в YouTube. По умолчанию — Private. Опубликуй в YouTube Studio когда готова.',
  }));
}
