import { Hono } from 'hono';
import type { TransportMode, TransportTripType, User } from '../types';
import { stringifyAuditJson } from '../utils/audit';
import { getPublicConfig } from '../utils/config';
import { hashPassword, verifyPassword, verifySecret } from '../utils/password';
import { checkRateLimit } from '../utils/rate-limit';
import { toSqliteDateTime } from '../utils/time';
import {
  authMiddleware,
  clearSessionCookie,
  consumePasswordReauthentication,
  createSession,
  getRequestUser,
  getSessionToken,
  markSessionReauthenticated,
  revokeSession,
  setSessionCookie,
} from '../middleware/auth';
import {
  assertOnlyKeys,
  boundedInteger,
  defaultWorkTypeValue,
  displayNameValue,
  optionalString,
  passwordValue,
  readJsonObject,
  RequestValidationError,
  transportModeValue,
  tripTypeValue,
  usernameValue,
  nullableTime,
} from '../utils/validation';

type AuthVars = {
  Variables: { user: User };
  Bindings: CloudflareBindings;
};

type PublicUser = Pick<
  User,
  | 'id'
  | 'username'
  | 'display_name'
  | 'is_admin'
  | 'default_one_way_fare'
  | 'default_trip_type'
  | 'default_transport_mode'
  | 'default_transport_origin'
  | 'default_transport_destination'
  | 'default_clock_in'
  | 'default_clock_out'
  | 'default_break_minutes'
  | 'default_work_type'
>;

type LoginUser = User & { password_hash: string };

const DUMMY_PASSWORD_HASH =
  'pbkdf2_sha256$100000$000102030405060708090a0b0c0d0e0f$f5189e60cb03088f4e88e76da67f422cc0e45557767c3a85dc6b4c3e6c0825e0';
const SETUP_TOKEN_PLACEHOLDERS = new Set([
  'change-me',
  'replace-with-openssl-rand-hex-32',
]);

const auth = new Hono<AuthVars>();

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    is_admin: user.is_admin,
    default_one_way_fare: user.default_one_way_fare,
    default_trip_type: user.default_trip_type,
    default_transport_mode: user.default_transport_mode,
    default_transport_origin: user.default_transport_origin,
    default_transport_destination: user.default_transport_destination,
    default_clock_in: user.default_clock_in,
    default_clock_out: user.default_clock_out,
    default_break_minutes: user.default_break_minutes,
    default_work_type: user.default_work_type,
  };
}


function loginIdentifier(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new RequestValidationError(`${label}は必須です`);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new RequestValidationError(`${label}の形式が正しくありません`);
  }
  return normalized;
}

function credentialString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new RequestValidationError(`${label}の形式が正しくありません`);
  }
  return value;
}

function optionalFare(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return boundedInteger(value, 'デフォルト片道交通費', 0, 100_000);
}

function optionalTripType(value: unknown): TransportTripType | undefined {
  return value === undefined ? undefined : tripTypeValue(value);
}

function optionalTransportMode(value: unknown): TransportMode | undefined {
  return value === undefined ? undefined : transportModeValue(value);
}

auth.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

// GET /api/auth/status
auth.get('/status', async (c) => {
  const configured = await c.env.DB.prepare(
    'SELECT EXISTS(SELECT 1 FROM users LIMIT 1) AS value',
  ).first<{ value: number }>();
  const user = await getRequestUser(c.env, c.req.raw);

  return c.json({
    setup_required: configured?.value !== 1,
    authenticated: user !== null,
    user: user ? toPublicUser(user) : null,
  });
});

// POST /api/auth/setup
auth.post('/setup', async (c) => {
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, [
    'setup_token',
    'username',
    'password',
    'display_name',
    'default_one_way_fare',
    'default_trip_type',
    'default_transport_mode',
    'default_transport_origin',
    'default_transport_destination',
    'default_clock_in',
    'default_clock_out',
    'default_break_minutes',
    'default_work_type',
  ]);

  const setupAllowed = await checkRateLimit(
    c.env.AUTH_RATE_LIMITER,
    `setup:${clientAddress(c.req.raw)}`,
    c.req.raw,
  );
  if (!setupAllowed) return c.json({ error: '試行回数が多すぎます。しばらくしてからもう一度お試しください' }, 429);

  const providedSetupToken = typeof body.setup_token === 'string' ? body.setup_token : '';
  const expectedSetupToken = c.env.SETUP_TOKEN;
  if (
    !expectedSetupToken
    || expectedSetupToken.length < 32
    || SETUP_TOKEN_PLACEHOLDERS.has(expectedSetupToken)
  ) {
    return c.json({ error: '初期設定は現在利用できません' }, 503);
  }
  if (!providedSetupToken || !(await verifySecret(providedSetupToken, expectedSetupToken))) {
    return c.json({ error: '初期設定の認証情報が正しくありません' }, 403);
  }

  const username = usernameValue(body.username);
  const password = passwordValue(body.password);
  const requestedName = optionalString(body.display_name, '氏名', 80);
  const displayName = requestedName ? displayNameValue(requestedName) : username;
  const defaultOneWayFare = optionalFare(body.default_one_way_fare) ?? null;
  const defaultTripType = optionalTripType(body.default_trip_type) ?? 'round_trip';
  const defaultTransportMode = optionalTransportMode(body.default_transport_mode) ?? 'rail';
  const defaultTransportOrigin = optionalString(body.default_transport_origin, '出発地', 120) ?? '';
  const defaultTransportDestination = optionalString(body.default_transport_destination, '到着地', 120) ?? '';
  const defaultClockIn = nullableTime(body.default_clock_in, 'デフォルト出勤時間') ?? null;
  const defaultClockOut = nullableTime(body.default_clock_out, 'デフォルト退勤時間') ?? null;
  const defaultBreakMinutes = boundedInteger(
    body.default_break_minutes,
    'デフォルト休憩（分）',
    0,
    480,
    getPublicConfig(c.env).default_break_minutes,
  );
  const defaultWorkType = defaultWorkTypeValue(body.default_work_type, 'office');
  const passwordHash = await hashPassword(password);
  // Must match SQLite's `datetime('now')` default used for every other user,
  // both so the column keeps one format and so the audit statement below can
  // correlate on it inside the same batch.
  const createdAt = toSqliteDateTime(new Date());

  const insert = c.env.DB.prepare(
    `INSERT INTO users (
       username,
       password_hash,
       display_name,
       is_admin,
       default_one_way_fare,
       default_trip_type,
       default_transport_mode,
       default_transport_origin,
       default_transport_destination,
       default_clock_in,
       default_clock_out,
       default_break_minutes,
       default_work_type,
       created_at
     )
     SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM users)
     RETURNING
       id,
       username,
       display_name,
       is_admin,
       created_at,
       default_one_way_fare,
       default_trip_type,
       default_transport_mode,
       default_transport_origin,
       default_transport_destination,
       default_clock_in,
       default_clock_out,
       default_break_minutes,
       default_work_type,
       auth_version`,
  ).bind(
    username,
    passwordHash,
    displayName,
    defaultOneWayFare,
    defaultTripType,
    defaultTransportMode,
    defaultTransportOrigin,
    defaultTransportDestination,
    defaultClockIn,
    defaultClockOut,
    defaultBreakMinutes,
    defaultWorkType,
    createdAt,
  );
  const setupAudit = c.env.DB.prepare(
    `INSERT INTO audit_logs (
       actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
     )
     SELECT id, id, 'initial_setup', 'user', CAST(id AS TEXT), NULL, ?
     FROM users
     WHERE username = ? AND created_at = ?`,
  ).bind(
    stringifyAuditJson({
      username,
      display_name: displayName,
      is_admin: 1,
      default_one_way_fare: defaultOneWayFare,
      default_trip_type: defaultTripType,
      default_transport_mode: defaultTransportMode,
      default_transport_origin: defaultTransportOrigin,
      default_transport_destination: defaultTransportDestination,
      default_clock_in: defaultClockIn,
      default_clock_out: defaultClockOut,
      default_break_minutes: defaultBreakMinutes,
      default_work_type: defaultWorkType,
    }),
    username,
    createdAt,
  );
  const results = await c.env.DB.batch([insert, setupAudit]);
  const user = results[0]?.results?.[0] as User | undefined;

  if (!user) return c.json({ error: 'システムの初期設定はすでに完了しています' }, 403);

  const session = await createSession(c.env, user.id, user.auth_version);
  if (!session) throw new Error('Initial session creation failed');
  return c.json(
    { success: true, user: toPublicUser(user) },
    201,
    { 'Set-Cookie': setSessionCookie(session) },
  );
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, ['username', 'password']);
  const username = loginIdentifier(body.username, 'ログインID', 64).toLowerCase();
  const password = credentialString(body.password, 'パスワード', 128);
  const [addressAllowed, accountAllowed] = await Promise.all([
    checkRateLimit(c.env.AUTH_RATE_LIMITER, `login-ip:${clientAddress(c.req.raw)}`, c.req.raw),
    checkRateLimit(c.env.AUTH_RATE_LIMITER, `login-account:${username}`, c.req.raw),
  ]);
  if (!addressAllowed || !accountAllowed) {
    return c.json({ error: '試行回数が多すぎます。しばらくしてからもう一度お試しください' }, 429);
  }

  const row = await c.env.DB.prepare(
    `SELECT
       id,
       username,
       password_hash,
       display_name,
       is_admin,
       created_at,
       default_one_way_fare,
       default_trip_type,
       default_transport_mode,
       default_transport_origin,
       default_transport_destination,
       default_clock_in,
       default_clock_out,
       default_break_minutes,
       default_work_type,
       auth_version
     FROM users
     WHERE username = ?
     LIMIT 1`,
  )
    .bind(username)
    .first<LoginUser>();

  const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !valid) {
    return c.json({ error: 'ログインIDまたはパスワードが間違っています' }, 401);
  }

  const session = await createSession(c.env, row.id, row.auth_version);
  if (!session) {
    return c.json({ error: 'ログイン状態が更新されました。もう一度お試しください' }, 409);
  }
  return c.json(
    { success: true, user: toPublicUser(row) },
    200,
    { 'Set-Cookie': setSessionCookie(session) },
  );
});

// POST /api/auth/logout
auth.post('/logout', async (c) => {
  const token = getSessionToken(c.req.raw);
  try {
    await revokeSession(c.env, token);
  } catch (error) {
    console.error(JSON.stringify({
      message: 'session revocation failed',
      error: error instanceof Error ? error.message : String(error),
    }));
    return c.json(
      { error: 'ログアウトに失敗しました。しばらくしてからもう一度お試しください' },
      503,
      { 'Set-Cookie': clearSessionCookie() },
    );
  }

  return c.json(
    { success: true },
    200,
    { 'Set-Cookie': clearSessionCookie() },
  );
});

// GET /api/auth/me
auth.get('/me', authMiddleware, (c) => c.json(toPublicUser(c.get('user'))));

// PATCH /api/auth/profile
auth.patch('/profile', authMiddleware, async (c) => {
  const currentUser = c.get('user');
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, [
    'display_name',
    'default_one_way_fare',
    'default_trip_type',
    'default_transport_mode',
    'default_transport_origin',
    'default_transport_destination',
    'default_clock_in',
    'default_clock_out',
    'default_break_minutes',
    'default_work_type',
  ]);

  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  const displayName = body.display_name === undefined
    ? undefined
    : displayNameValue(body.display_name);
  const defaultOneWayFare = optionalFare(body.default_one_way_fare);
  const defaultTripType = optionalTripType(body.default_trip_type);
  const defaultTransportMode = optionalTransportMode(body.default_transport_mode);
  const defaultTransportOrigin = body.default_transport_origin === undefined
    ? undefined
    : optionalString(body.default_transport_origin, '出発地', 120) ?? '';
  const defaultTransportDestination = body.default_transport_destination === undefined
    ? undefined
    : optionalString(body.default_transport_destination, '到着地', 120) ?? '';
  const defaultClockIn = nullableTime(body.default_clock_in, 'デフォルト出勤時間');
  const defaultClockOut = nullableTime(body.default_clock_out, 'デフォルト退勤時間');
  const defaultBreakMinutes = body.default_break_minutes === undefined
    ? undefined
    : boundedInteger(body.default_break_minutes, 'デフォルト休憩（分）', 0, 480);
  const defaultWorkType = body.default_work_type === undefined
    ? undefined
    : defaultWorkTypeValue(body.default_work_type);

  if (displayName !== undefined) {
    assignments.push('display_name = ?');
    values.push(displayName);
  }

  if (body.default_one_way_fare !== undefined) {
    assignments.push('default_one_way_fare = ?');
    values.push(defaultOneWayFare ?? null);
  }

  if (defaultTripType !== undefined) {
    assignments.push('default_trip_type = ?');
    values.push(defaultTripType);
  }

  if (defaultTransportMode !== undefined) {
    assignments.push('default_transport_mode = ?');
    values.push(defaultTransportMode);
  }

  if (defaultTransportOrigin !== undefined) {
    assignments.push('default_transport_origin = ?');
    values.push(defaultTransportOrigin);
  }

  if (defaultTransportDestination !== undefined) {
    assignments.push('default_transport_destination = ?');
    values.push(defaultTransportDestination);
  }

  if (body.default_clock_in !== undefined) {
    assignments.push('default_clock_in = ?');
    values.push(defaultClockIn ?? null);
  }

  if (body.default_clock_out !== undefined) {
    assignments.push('default_clock_out = ?');
    values.push(defaultClockOut ?? null);
  }

  if (defaultBreakMinutes !== undefined) {
    assignments.push('default_break_minutes = ?');
    values.push(defaultBreakMinutes);
  }

  if (defaultWorkType !== undefined) {
    assignments.push('default_work_type = ?');
    values.push(defaultWorkType);
  }

  if (assignments.length === 0) {
    throw new RequestValidationError('更新する項目を少なくとも1つ指定してください');
  }

  values.push(currentUser.id);
  const update = c.env.DB.prepare(
    `UPDATE users
     SET ${assignments.join(', ')}
     WHERE id = ?
     RETURNING
       id,
       username,
       display_name,
       is_admin,
       created_at,
       default_one_way_fare,
       default_trip_type,
       default_transport_mode,
       default_transport_origin,
       default_transport_destination,
       default_clock_in,
       default_clock_out,
       default_break_minutes,
       default_work_type,
       auth_version`,
  )
    .bind(...values);
  const afterForAudit = {
    ...currentUser,
    ...(displayName !== undefined ? { display_name: displayName } : {}),
    ...(body.default_one_way_fare !== undefined
      ? { default_one_way_fare: defaultOneWayFare ?? null }
      : {}),
    ...(defaultTripType !== undefined ? { default_trip_type: defaultTripType } : {}),
    ...(defaultTransportMode !== undefined ? { default_transport_mode: defaultTransportMode } : {}),
    ...(defaultTransportOrigin !== undefined ? { default_transport_origin: defaultTransportOrigin } : {}),
    ...(defaultTransportDestination !== undefined
      ? { default_transport_destination: defaultTransportDestination }
      : {}),
    ...(body.default_clock_in !== undefined
      ? { default_clock_in: defaultClockIn ?? null }
      : {}),
    ...(body.default_clock_out !== undefined
      ? { default_clock_out: defaultClockOut ?? null }
      : {}),
    ...(defaultBreakMinutes !== undefined
      ? { default_break_minutes: defaultBreakMinutes }
      : {}),
    ...(defaultWorkType !== undefined
      ? { default_work_type: defaultWorkType }
      : {}),
  };
  const results = await c.env.DB.batch([
    update,
    authAuditStatement(c.env, currentUser.id, 'profile_update', currentUser, afterForAudit),
  ]);
  const updated = results[0]?.results?.[0] as User | undefined;

  if (!updated) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ success: true, user: toPublicUser(updated) });
});

// POST /api/auth/profile/password/verify
// Keep password verification and password hashing in separate requests so each
// request performs at most one intentionally expensive PBKDF2 operation.
auth.post('/profile/password/verify', authMiddleware, async (c) => {
  const currentUser = c.get('user');
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, ['current_password']);
  const currentPassword = credentialString(body.current_password, '現在のパスワード', 128);

  const [verifyAddressAllowed, verifyAccountAllowed] = await Promise.all([
    checkRateLimit(c.env.AUTH_RATE_LIMITER, `password-verify-ip:${clientAddress(c.req.raw)}`, c.req.raw),
    checkRateLimit(c.env.AUTH_RATE_LIMITER, `password-verify-account:${currentUser.id}`, c.req.raw),
  ]);
  if (!verifyAddressAllowed || !verifyAccountAllowed) {
    return c.json({ error: '試行回数が多すぎます。しばらくしてからもう一度お試しください' }, 429);
  }

  const credential = await c.env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
  )
    .bind(currentUser.id)
    .first<{ password_hash: string }>();
  const valid = credential
    ? await verifyPassword(currentPassword, credential.password_hash)
    : false;
  if (!valid) return c.json({ error: '現在のパスワードが正しくありません' }, 401);

  const reauthToken = await markSessionReauthenticated(c.env, c.req.raw, currentUser.id);
  if (!reauthToken) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({
    success: true,
    reauth_token: reauthToken,
    expires_in_seconds: 300,
  });
});

// POST /api/auth/profile/password
auth.post('/profile/password', authMiddleware, async (c) => {
  const currentUser = c.get('user');
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, ['new_password', 'reauth_token']);
  const newPassword = passwordValue(body.new_password, '新しいパスワード');
  const reauthToken = credentialString(body.reauth_token, '再認証トークン', 64);

  const recentlyVerified = await consumePasswordReauthentication(
    c.env,
    c.req.raw,
    currentUser.id,
    reauthToken,
  );
  if (!recentlyVerified) {
    return c.json({ error: '現在のパスワードを再認証してください' }, 403);
  }

  const passwordHash = await hashPassword(newPassword);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users
       SET password_hash = ?, auth_version = auth_version + 1
       WHERE id = ?
       RETURNING auth_version`,
    )
      .bind(passwordHash, currentUser.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?')
      .bind(currentUser.id),
    authAuditStatement(c.env, currentUser.id, 'password_change', null, null),
  ]);
  const credential = results[0]?.results?.[0] as { auth_version: number } | undefined;
  if (!credential) return c.json({ error: 'Unauthorized' }, 401);

  const session = await createSession(c.env, currentUser.id, credential.auth_version);
  if (!session) {
    return c.json(
      { error: 'パスワードが更新されました。新しいパスワードで再ログインしてください' },
      409,
      { 'Set-Cookie': clearSessionCookie() },
    );
  }
  return c.json(
    { success: true, user: toPublicUser(currentUser) },
    200,
    { 'Set-Cookie': setSessionCookie(session) },
  );
});

function authAuditStatement(
  env: CloudflareBindings,
  userId: number,
  action: string,
  before: unknown,
  after: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_logs (
       actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
     ) VALUES (?, ?, ?, 'user', ?, ?, ?)`,
  ).bind(
    userId,
    userId,
    action,
    String(userId),
    before === null ? null : stringifyAuditJson(before),
    after === null ? null : stringifyAuditJson(after),
  );
}

function clientAddress(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.slice(0, 64) || 'unknown';
}

export default auth;
