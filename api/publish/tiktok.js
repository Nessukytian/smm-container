import { parseCookies } from '../_lib/cookies.js';

// Publish a video to the user's TikTok DRAFTS via the Content Posting API.
// Frontend sends JSON: { video_base64, filename, title? }
// We init an FILE_UPLOAD on TikTok, get an upload_url, PUT the binary, done.
//
// Vercel serverless body limit (Hobby plan) is 4.5MB — keep test clips short.

export const config = {
  api: {
    bodyParser: { sizeLimit: '5mb' },
  },
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: 'POST only' }));
  }

  const cookies = parseCookies(req);
  const token = cookies.tt_access_token;
  if (!token) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: 'not connected to TikTok' }));
  }

  const { video_base64, filename } = req.body || {};
  if (!video_base64) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'video_base64 missing' }));
  }

  // Decode the video.
  let videoBytes;
  try {
    videoBytes = Buffer.from(video_base64, 'base64');
  } catch (e) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'bad base64' }));
  }

  const videoSize = videoBytes.length;
  if (videoSize === 0) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'empty video' }));
  }

  // 1) Initialize the inbox upload — TikTok returns a publish_id and an upload_url.
  let initData;
  try {
    const initResp = await fetch(
      'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: videoSize,
            chunk_size: videoSize,
            total_chunk_count: 1,
          },
        }),
      }
    );
    initData = await initResp.json();
  } catch (e) {
    res.statusCode = 502;
    return res.end(
      JSON.stringify({ ok: false, error: 'init failed: ' + (e.message || e) })
    );
  }

  if (initData?.error?.code && initData.error.code !== 'ok') {
    res.statusCode = 502;
    return res.end(
      JSON.stringify({ ok: false, stage: 'init', error: initData.error })
    );
  }

  const uploadUrl = initData?.data?.upload_url;
  const publishId = initData?.data?.publish_id;
  if (!uploadUrl) {
    res.statusCode = 502;
    return res.end(
      JSON.stringify({ ok: false, stage: 'init', error: 'no upload_url', initData })
    );
  }

  // 2) PUT the bytes.
  try {
    const putResp = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(videoSize),
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      body: videoBytes,
    });
    if (!putResp.ok) {
      const text = await putResp.text();
      res.statusCode = 502;
      return res.end(
        JSON.stringify({
          ok: false,
          stage: 'upload',
          error: `upload returned ${putResp.status}`,
          body: text.slice(0, 500),
        })
      );
    }
  } catch (e) {
    res.statusCode = 502;
    return res.end(
      JSON.stringify({ ok: false, stage: 'upload', error: e.message || String(e) })
    );
  }

  return res.end(
    JSON.stringify({
      ok: true,
      publish_id: publishId,
      filename: filename || 'video.mp4',
      message: 'Видео отправлено в драфты TikTok. Открой приложение TikTok → Профиль → Drafts.',
    })
  );
}
