import { createMiddleware } from 'hono/factory';
import type { User } from '../types';
import { getSessionTtlSeconds } from '../utils/config';
import { parseDatabaseTimestamp, toSqliteDateTime } from '../utils/time';

export type AuthEnv = {
  Variables: {
    user: User;
  };
  Bindings: CloudflareBindings;
};

export interface SessionHandle {
  token: string;
  expiresAt: Date;
}

/** The authenticated user plus the timestamps of the session that proved it. */
export type SessionUser = User & {
  session_expires_at: string;
  session_created_at: string;
};

const COOKIE_NAME = '__Host-edge_kintai_session';
const SESSION_TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Ceiling on how long sliding renewal can keep one login alive, counted from
 * the session's creation. It equals the largest accepted SESSION_TTL_SECONDS,
 * so configuring a 30-day TTL effectively turns renewal off.
 */
const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

async function requestSessionHash(request: Request): Promise<string | null> {
  const token = getSessionToken(request);
  return token ? hashSessionToken(token) : null;
}

function newOpaqueToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
}

export function getSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === COOKIE_NAME && TOKEN_PATTERN.test(value)) return value;
  }
  return null;
}

export async function getSessionUser(
  env: CloudflareBindings,
  token: string,
): Promise<SessionUser | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const tokenHash = await hashSessionToken(token);
  return env.DB.prepare(
    `SELECT
       s.expires_at AS session_expires_at,
       s.created_at AS session_created_at,
       u.id,
       u.username,
       u.display_name,
       u.is_admin,
       u.created_at,
       u.default_one_way_fare,
       u.default_trip_type,
       u.default_transport_mode,
       u.default_transport_origin,
       u.default_transport_destination,
       u.default_clock_in,
       u.default_clock_out,
       u.default_break_minutes,
       u.default_work_type,
       u.auth_version
     FROM sessions AS s
     INNER JOIN users AS u ON u.id = s.user_id
     WHERE s.token_id = ?
       AND s.auth_version = u.auth_version
       AND s.expires_at > datetime('now')
     LIMIT 1`,
  )
    .bind(tokenHash)
    .first<SessionUser>();
}

export async function getRequestUser(
  env: CloudflareBindings,
  request: Request,
): Promise<SessionUser | null> {
  const token = getSessionToken(request);
  return token ? getSessionUser(env, token) : null;
}

/**
 * Slides an in-use session forward once less than half of its TTL remains, so
 * someone who punches in every day is not signed out mid-week. That costs at
 * most one D1 write per session per half-TTL, and never extends a session past
 * SESSION_ABSOLUTE_LIFETIME_MS from its creation.
 */
export async function renewSessionIfDue(
  env: CloudflareBindings,
  token: string,
  user: SessionUser,
  now = Date.now(),
): Promise<SessionHandle | null> {
  const expiresAt = parseDatabaseTimestamp(user.session_expires_at);
  const createdAt = parseDatabaseTimestamp(user.session_created_at);
  if (expiresAt === null || createdAt === null) return null;

  const ttlMs = getSessionTtlSeconds(env) * 1000;
  if (expiresAt - now > ttlMs / 2) return null;
  // Whole seconds, because that is all the TEXT column and the cookie keep.
  const renewedAt = Math.floor(
    Math.min(now + ttlMs, createdAt + SESSION_ABSOLUTE_LIFETIME_MS) / 1000,
  ) * 1000;
  if (renewedAt <= expiresAt) return null;

  const renewed = new Date(renewedAt);
  // Matching the old expires_at lets only one of several concurrent requests
  // renew; the others simply leave the cookie they came with in place.
  const result = await env.DB.prepare(
    `UPDATE sessions
     SET expires_at = ?
     WHERE token_id = ? AND user_id = ? AND expires_at = ?`,
  )
    .bind(toSqliteDateTime(renewed), await hashSessionToken(token), user.id, user.session_expires_at)
    .run();
  return (result.meta.changes ?? 0) === 1 ? { token, expiresAt: renewed } : null;
}

export async function markSessionReauthenticated(
  env: CloudflareBindings,
  request: Request,
  userId: number,
): Promise<string | null> {
  const [tokenHash, reauthToken] = await Promise.all([
    requestSessionHash(request),
    Promise.resolve(newOpaqueToken()),
  ]);
  if (!tokenHash) return null;
  const reauthTokenHash = await hashSessionToken(reauthToken);
  const result = await env.DB.prepare(
    `UPDATE sessions
     SET reauthenticated_at = datetime('now'), reauth_token_hash = ?
     WHERE token_id = ? AND user_id = ? AND expires_at > datetime('now')`,
  )
    .bind(reauthTokenHash, tokenHash, userId)
    .run();
  return (result.meta.changes ?? 0) === 1 ? reauthToken : null;
}

export async function consumePasswordReauthentication(
  env: CloudflareBindings,
  request: Request,
  userId: number,
  reauthToken: string,
): Promise<boolean> {
  if (!TOKEN_PATTERN.test(reauthToken)) return false;
  const tokenHash = await requestSessionHash(request);
  if (!tokenHash) return false;
  const reauthTokenHash = await hashSessionToken(reauthToken);
  const consumed = await env.DB.prepare(
    `UPDATE sessions
     SET reauthenticated_at = NULL, reauth_token_hash = NULL
     WHERE token_id = ?
       AND user_id = ?
       AND expires_at > datetime('now')
       AND reauthenticated_at >= datetime('now', '-5 minutes')
       AND reauth_token_hash = ?
     RETURNING token_id`,
  )
    .bind(tokenHash, userId, reauthTokenHash)
    .first<{ token_id: string }>();
  return consumed !== null;
}

export async function createSession(
  env: CloudflareBindings,
  userId: number,
  expectedAuthVersion: number,
): Promise<SessionHandle | null> {
  const ttlSeconds = getSessionTtlSeconds(env);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const token = newOpaqueToken();
  const tokenHash = await hashSessionToken(token);

  const inserted = await env.DB.prepare(
    `INSERT INTO sessions (token_id, user_id, expires_at, auth_version)
     SELECT ?, id, ?, auth_version
     FROM users
     WHERE id = ? AND auth_version = ?`,
  )
    .bind(tokenHash, toSqliteDateTime(expiresAt), userId, expectedAuthVersion)
    .run();

  if ((inserted.meta.changes ?? 0) !== 1) return null;

  return { token, expiresAt };
}

export async function revokeSession(
  env: CloudflareBindings,
  token: string | null,
): Promise<void> {
  if (!token || !TOKEN_PATTERN.test(token)) return;
  const tokenHash = await hashSessionToken(token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_id = ?').bind(tokenHash).run();
}

export async function revokeAllUserSessions(
  env: CloudflareBindings,
  userId: number,
): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const token = getSessionToken(c.req.raw);
  const user = token ? await getSessionUser(c.env, token) : null;
  if (!token || !user) {
    return c.json(
      { error: 'Unauthorized' },
      401,
      { 'Set-Cookie': clearSessionCookie() },
    );
  }

  c.set('user', user);
  await next();

  // A handler that already rotated or cleared the cookie (password change)
  // owns it, and a request that ended unauthenticated must not extend anything.
  if (c.res.status === 401 || c.res.headers.has('Set-Cookie')) return;
  try {
    const renewed = await renewSessionIfDue(c.env, token, user);
    if (renewed) c.res.headers.append('Set-Cookie', setSessionCookie(renewed));
  } catch (error) {
    // The handler's work has already succeeded; a failed renewal only means
    // the session keeps its current expiry, so it must not turn into a 500.
    console.error(JSON.stringify({
      level: 'error',
      event: 'session_renewal_failed',
      error: error instanceof Error ? error.name : 'UnknownError',
    }));
  }
});

export function setSessionCookie(session: SessionHandle): string {
  const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${COOKIE_NAME}=${session.token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
    `Expires=${session.expiresAt.toUTCString()}`,
  ].join('; ');
}

export function clearSessionCookie(): string {
  return [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}
