import { parseCookies } from '../_lib/cookies.js';
import { getAccessiblePages } from '../_lib/meta-pages.js';
import { put } from '@vercel/blob';

// Publish a video to Instagram and/or Facebook Pages via Meta Graph API.
// Frontend sends JSON: { video_base64, filename, caption, targets: ['instagram', 'facebook'], page_id?, ig_user_id? }
//
// Flow:
//   1. Upload video to Vercel Blob → get public URL
//   2. For Instagram: create media container (REELS/VIDEO), poll until FINISHED, publish
//   3. For Facebook Page: POST /{page-id}/videos with file_url
//   4. Return aggregated result

export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
  maxDuration: 60, // Vercel Pro+: extend to 60s. On Hobby capped at 10s.
};

const META_VERSION = 'v21.0';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: 'POST only' }));
  }

  const cookies = parseCookies(req);
  const userToken = cookies.meta_access_token;
  if (!userToken) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: 'not connected to Meta' }));
  }

  const { video_base64, filename, caption, targets, page_id, ig_user_id } = req.body || {};
  const wantsIG = Array.isArray(targets) && targets.includes('instagram');
  const wantsFB = Array.isArray(targets) && targets.includes('facebook');

  if (!wantsIG && !wantsFB) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'no targets specified' }));
  }
  if (!video_base64) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'video_base64 missing' }));
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: 'Vercel Blob not configured' }));
  }

  // 1) Upload bytes → Vercel Blob
  let publicUrl;
  try {
    const bytes = Buffer.from(video_base64, 'base64');
    const safeName = (filename || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`uploads/${Date.now()}-${safeName}`, bytes, {
      access: 'public',
      contentType: 'video/mp4',
      addRandomSuffix: true,
    });
    publicUrl = blob.url;
  } catch (e) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, stage: 'blob', error: e.message || String(e) }));
  }

  // We need /me/accounts to find the right page_token + ig_user_id if not provided
  let resolvedPageId = page_id;
  let resolvedIgUserId = ig_user_id;
  let pageToken = userToken;

  if (wantsIG || wantsFB) {
    try {
      const pages = await getAccessiblePages(userToken);
      const targetPage = resolvedPageId
        ? pages.find(p => p.id === resolvedPageId)
        : pages.find(p => (wantsIG ? !!p.instagram : true)) || pages[0];
      if (targetPage) {
        resolvedPageId = targetPage.id;
        pageToken = targetPage.page_access_token || userToken;
        if (targetPage.instagram) {
          resolvedIgUserId = resolvedIgUserId || targetPage.instagram.id;
        }
      }
    } catch (e) { /* try anyway with user token */ }
  }

  const results = {};

  // 2) Instagram publish (Reels/video)
  if (wantsIG) {
    if (!resolvedIgUserId) {
      results.instagram = { ok: false, error: 'No Instagram Business account linked to your Pages' };
    } else {
      try {
        // Step A: create media container
        const initUrl = new URL(`https://graph.facebook.com/${META_VERSION}/${resolvedIgUserId}/media`);
        const initBody = new URLSearchParams({
          media_type: 'REELS',
          video_url: publicUrl,
          caption: (caption || '').slice(0, 2200),
          access_token: pageToken,
        });
        const initResp = await fetch(initUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: initBody.toString(),
        });
        const initData = await initResp.json();
        if (initData.error || !initData.id) {
          results.instagram = { ok: false, stage: 'container', error: initData.error?.message || JSON.stringify(initData) };
        } else {
          const containerId = initData.id;
          // Step B: poll status (up to ~7s on Hobby plan)
          let finished = false;
          const startTime = Date.now();
          while (Date.now() - startTime < 25_000) {
            await sleep(2500);
            const statusUrl = new URL(`https://graph.facebook.com/${META_VERSION}/${containerId}`);
            statusUrl.searchParams.set('fields', 'status_code,status');
            statusUrl.searchParams.set('access_token', pageToken);
            const sr = await fetch(statusUrl.toString());
            const sd = await sr.json();
            if (sd.status_code === 'FINISHED') { finished = true; break; }
            if (sd.status_code === 'ERROR' || sd.status_code === 'EXPIRED') {
              results.instagram = { ok: false, stage: 'processing', error: sd.status || sd.status_code };
              break;
            }
          }
          if (finished) {
            // Step C: publish
            const pubUrl = new URL(`https://graph.facebook.com/${META_VERSION}/${resolvedIgUserId}/media_publish`);
            const pubBody = new URLSearchParams({
              creation_id: containerId,
              access_token: pageToken,
            });
            const pubResp = await fetch(pubUrl.toString(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: pubBody.toString(),
            });
            const pubData = await pubResp.json();
            if (pubData.error || !pubData.id) {
              results.instagram = { ok: false, stage: 'publish', error: pubData.error?.message || JSON.stringify(pubData) };
            } else {
              results.instagram = { ok: true, media_id: pubData.id };
            }
          } else if (!results.instagram) {
            results.instagram = { ok: false, stage: 'processing', error: 'timeout — try shorter video', container_id: containerId };
          }
        }
      } catch (e) {
        results.instagram = { ok: false, error: e.message || String(e) };
      }
    }
  }

  // 3) Facebook Page video upload (uses file_url, page-scoped token)
  if (wantsFB) {
    if (!resolvedPageId) {
      results.facebook = { ok: false, error: 'No Facebook Page found' };
    } else if (!pageToken || pageToken === userToken) {
      results.facebook = { ok: false, error: 'Page token недоступен — добавь pages_manage_posts в приложение Meta' };
    } else {
      try {
        const fbUrl = new URL(`https://graph.facebook.com/${META_VERSION}/${resolvedPageId}/videos`);
        const fbBody = new URLSearchParams({
          file_url: publicUrl,
          description: caption || '',
          access_token: pageToken,
        });
        const fbResp = await fetch(fbUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: fbBody.toString(),
        });
        const fbData = await fbResp.json();
        if (fbData.error || !fbData.id) {
          results.facebook = { ok: false, error: fbData.error?.message || JSON.stringify(fbData) };
        } else {
          results.facebook = { ok: true, video_id: fbData.id };
        }
      } catch (e) {
        results.facebook = { ok: false, error: e.message || String(e) };
      }
    }
  }

  const anyOk = Object.values(results).some(r => r.ok);
  return res.end(JSON.stringify({
    ok: anyOk,
    blob_url: publicUrl,
    results,
  }));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
