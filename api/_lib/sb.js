// Supabase helpers — used by backend to read user_id from JWT and store/read OAuth tokens.
import { createClient } from '@supabase/supabase-js';
import { parseCookies } from './cookies.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vbgacydpvvbmfkyvomhp.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZiZ2FjeWRwdnZibWZreXZvbWhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1MjM4MDEsImV4cCI6MjA5MzA5OTgwMX0.diiYvMhVgc2rskoLPoKSWhAzT9za7KsO3dF56eKJ5Ew';

let _admin = null;
let _anon = null;

// Anon client — used to verify JWT tokens (just calls auth.getUser).
function anon() {
  if (!_anon) _anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  return _anon;
}

// Admin (service-role) client — bypasses RLS, used to write/read oauth_tokens.
function admin() {
  if (!_admin) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY env var not set');
    _admin = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
  }
  return _admin;
}

/**
 * Returns the Supabase user_id for the current request, or null.
 * Reads sb-access-token cookie (set by frontend on auth state change).
 */
export async function getUserId(req) {
  try {
    const cookies = parseCookies(req);
    const token = cookies['sb-access-token'];
    if (!token) return null;
    const { data: { user }, error } = await anon().auth.getUser(token);
    if (error) return null;
    return user?.id || null;
  } catch (e) {
    console.error('getUserId failed:', e?.message || e);
    return null;
  }
}

/**
 * Save (upsert) OAuth tokens for a user+platform combo.
 */
export async function saveToken(userId, platform, tokens) {
  if (!userId) return false;
  try {
    const sb = admin();
    const { error } = await sb.from('oauth_tokens').upsert({
      user_id: userId,
      platform,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at: tokens.expires_at || null,
      metadata: tokens.metadata || {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,platform' });
    if (error) {
      console.error('[sb] saveToken failed:', error);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[sb] saveToken exception:', e?.message || e);
    return false;
  }
}

/**
 * Get stored OAuth token for user+platform. Returns null if not found.
 */
export async function getToken(userId, platform) {
  if (!userId) return null;
  try {
    const sb = admin();
    const { data, error } = await sb
      .from('oauth_tokens')
      .select('access_token, refresh_token, expires_at, metadata')
      .eq('user_id', userId)
      .eq('platform', platform)
      .maybeSingle();
    if (error) {
      console.error('[sb] getToken failed:', error);
      return null;
    }
    return data || null;
  } catch (e) {
    console.error('[sb] getToken exception:', e?.message || e);
    return null;
  }
}

/**
 * Delete stored token (when user disconnects).
 */
export async function deleteToken(userId, platform) {
  if (!userId) return;
  try {
    const sb = admin();
    await sb.from('oauth_tokens').delete()
      .eq('user_id', userId).eq('platform', platform);
  } catch (e) {
    console.error('[sb] deleteToken exception:', e?.message || e);
  }
}
