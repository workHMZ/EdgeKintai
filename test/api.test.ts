import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/middleware/auth';
import { previousDate, todayJST } from '../src/utils/time';

const origin = 'https://example.test';
const setupToken = 'test-setup-token-0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.useRealTimers();
});

async function jsonRequest(
  path: string,
  method: string,
  body?: Record<string, unknown>,
  cookie?: string,
  requestOrigin = origin,
): Promise<Response> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Origin: requestOrigin,
  });
  if (cookie) headers.set('Cookie', cookie);
  // Simulate an editor that reads the current version before each normal write.
  // Concurrency tests below use explicit headers to retain stale snapshots.
  const attendanceDate = /^\/api\/attendance\/(\d{4})-(\d{2})-(\d{2})$/.exec(path);
  if (cookie && attendanceDate && ['PUT', 'DELETE'].includes(method)) {
    const monthResponse = await SELF.fetch(`${origin}/api/attendance/${attendanceDate[1]}/${Number(attendanceDate[2])}`, {
      headers: { Cookie: cookie },
    });
    const data = await monthResponse.json<{ records?: Array<{ id: number; revision: number; work_date: string }> }>();
    const record = data.records?.find((item) => item.work_date === path.slice(-10) && item.id > 0);
    if (record) headers.set('If-Match', `"${record.id}:${record.revision}"`);
    else headers.set('If-None-Match', '*');
  }
  return SELF.fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function setupAdmin(): Promise<{ cookie: string; user: Record<string, unknown> }> {
  const response = await jsonRequest('/api/auth/setup', 'POST', {
    setup_token: setupToken,
    username: 'admin',
    display_name: '山田 太郎',
    password: 'strong-password-123',
    default_one_way_fare: 220,
    default_trip_type: 'round_trip',
    default_transport_mode: 'rail',
    default_transport_origin: '新宿駅',
    default_transport_destination: '東京駅',
  });
  expect(response.status).toBe(201);
  const setCookie = response.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('__Host-edge_kintai_session=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('Secure');
  expect(setCookie).toContain('SameSite=Strict');
  return {
    cookie: setCookie.split(';', 1)[0],
    user: (await response.json<{ user: Record<string, unknown> }>()).user,
  };
}

describe('EdgeKintai API', () => {
  it('protects first setup and creates exactly one administrator', async () => {
    const publicConfig = await SELF.fetch(`${origin}/api/config`);
    expect(publicConfig.status).toBe(200);
    expect(await publicConfig.json()).toMatchObject({
      default_clock_in: '10:00',
      default_clock_out: '19:00',
    });

    const statusBefore = await SELF.fetch(`${origin}/api/auth/status`);
    expect(await statusBefore.json()).toMatchObject({ setup_required: true, authenticated: false });

    const rejected = await jsonRequest('/api/auth/setup', 'POST', {
      setup_token: 'wrong-token-that-is-long-enough-0000000000',
      username: 'attacker',
      display_name: 'Attacker',
      password: 'strong-password-123',
    });
    expect(rejected.status).toBe(403);

    const { cookie, user } = await setupAdmin();
    expect(user).toMatchObject({ username: 'admin', display_name: '山田 太郎', is_admin: 1 });

    const second = await jsonRequest('/api/auth/setup', 'POST', {
      setup_token: setupToken,
      username: 'second',
      display_name: 'Second',
      password: 'strong-password-123',
    });
    expect(second.status).toBe(403);

    const me = await SELF.fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ username: 'admin', is_admin: 1 });

    // Case-insensitive login verification
    const upperLogin = await jsonRequest('/api/auth/login', 'POST', {
      username: 'ADMIN',
      password: 'strong-password-123',
    });
    expect(upperLogin.status).toBe(200);

    const mixedLogin = await jsonRequest('/api/auth/login', 'POST', {
      username: 'Admin',
      password: 'strong-password-123',
    });
    expect(mixedLogin.status).toBe(200);
  });

  it('keeps login name separate while updating profile and rotating password sessions', async () => {
    const { cookie } = await setupAdmin();
    const invisibleDisplayName = await jsonRequest('/api/auth/profile', 'PATCH', {
      display_name: '\u200B',
    }, cookie);
    expect(invisibleDisplayName.status).toBe(400);

    const profile = await jsonRequest('/api/auth/profile', 'PATCH', {
      display_name: '佐藤 花子',
      default_one_way_fare: 310,
      default_trip_type: 'one_way',
      default_transport_mode: 'bus',
      default_transport_origin: '渋谷駅西口',
      default_transport_destination: '品川駅港南口',
      default_break_minutes: 45,
      default_work_type: 'remote',
    }, cookie);
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      user: {
        username: 'admin',
        display_name: '佐藤 花子',
        default_one_way_fare: 310,
        default_trip_type: 'one_way',
        default_transport_mode: 'bus',
        default_transport_origin: '渋谷駅西口',
        default_transport_destination: '品川駅港南口',
        default_break_minutes: 45,
        default_work_type: 'remote',
      },
    });

    const immutableLogin = await jsonRequest('/api/auth/profile', 'PATCH', {
      username: 'renamed-admin',
    }, cookie);
    expect(immutableLogin.status).toBe(400);
    await expect(
      env.DB.prepare("UPDATE users SET username = 'renamed-admin' WHERE id = 1").run(),
    ).rejects.toThrow(/username is immutable/);

    const exportAfterRename = await SELF.fetch(`${origin}/api/export/2026/7`, {
      headers: { Cookie: cookie },
    });
    expect(exportAfterRename.status).toBe(200);
    expect(await exportAfterRename.json()).toMatchObject({
      username: 'admin',
      employee_name: '佐藤 花子',
      default_one_way_fare: 310,
      default_trip_type: 'one_way',
      default_transport_mode: 'bus',
      default_transport_origin: '渋谷駅西口',
      default_transport_destination: '品川駅港南口',
    });

    const secondLogin = await jsonRequest('/api/auth/login', 'POST', {
      username: 'admin',
      password: 'strong-password-123',
    });
    expect(secondLogin.status).toBe(200);
    const secondCookie = (secondLogin.headers.get('set-cookie') ?? '').split(';', 1)[0];

    const unverified = await jsonRequest('/api/auth/profile/password', 'POST', {
      new_password: 'new-strong-password-456',
      reauth_token: '0'.repeat(64),
    }, cookie);
    expect(unverified.status).toBe(403);

    const wrongVerification = await jsonRequest('/api/auth/profile/password/verify', 'POST', {
      current_password: 'wrong-password-123',
    }, cookie);
    expect(wrongVerification.status).toBe(401);

    const verification = await jsonRequest('/api/auth/profile/password/verify', 'POST', {
      current_password: 'strong-password-123',
    }, cookie);
    expect(verification.status).toBe(200);
    const reauthToken = (await verification.json<{ reauth_token: string }>()).reauth_token;
    expect(reauthToken).toMatch(/^[0-9a-f]{64}$/);

    const changed = await jsonRequest('/api/auth/profile/password', 'POST', {
      new_password: 'new-strong-password-456',
      reauth_token: reauthToken,
    }, cookie);
    expect(changed.status).toBe(200);
    const newCookie = (changed.headers.get('set-cookie') ?? '').split(';', 1)[0];
    expect(newCookie).not.toBe(cookie);

    const oldSession = await SELF.fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(oldSession.status).toBe(401);
    const secondOldSession = await SELF.fetch(`${origin}/api/auth/me`, {
      headers: { Cookie: secondCookie },
    });
    expect(secondOldSession.status).toBe(401);
    const newSession = await SELF.fetch(`${origin}/api/auth/me`, { headers: { Cookie: newCookie } });
    expect(newSession.status).toBe(200);

    const oldPasswordLogin = await jsonRequest('/api/auth/login', 'POST', {
      username: 'admin',
      password: 'strong-password-123',
    });
    expect(oldPasswordLogin.status).toBe(401);
    const newPasswordLogin = await jsonRequest('/api/auth/login', 'POST', {
      username: 'admin',
      password: 'new-strong-password-456',
    });
    expect(newPasswordLogin.status).toBe(200);

    const credentialVersion = await env.DB.prepare(
      'SELECT auth_version FROM users WHERE id = 1',
    ).first<{ auth_version: number }>();
    expect(credentialVersion?.auth_version).toBe(2);
    expect(await createSession(env, 1, 1)).toBeNull();
    const liveSessionVersions = await env.DB.prepare(
      'SELECT DISTINCT auth_version FROM sessions WHERE user_id = 1 ORDER BY auth_version',
    ).all<{ auth_version: number }>();
    expect(liveSessionVersions.results).toEqual([{ auth_version: 2 }]);

    const replayed = await jsonRequest('/api/auth/profile/password', 'POST', {
      new_password: 'third-strong-password-789',
      reauth_token: reauthToken,
    }, newCookie);
    expect(replayed.status).toBe(403);

    const passwordAudit = await env.DB.prepare(
      "SELECT before_json, after_json FROM audit_logs WHERE action = 'password_change' ORDER BY id DESC LIMIT 1",
    ).first<{ before_json: string | null; after_json: string | null }>();
    expect(passwordAudit).toEqual({ before_json: null, after_json: null });
    const serializedAudit = await env.DB.prepare(
      "SELECT group_concat(COALESCE(before_json, '') || COALESCE(after_json, ''), '') AS value FROM audit_logs",
    ).first<{ value: string }>();
    expect(serializedAudit?.value ?? '').not.toContain('new-strong-password-456');
    expect(serializedAudit?.value ?? '').not.toContain('password_hash');
    expect(serializedAudit?.value ?? '').not.toContain('渋谷駅西口');
    expect(serializedAudit?.value ?? '').not.toContain('品川駅港南口');
  });

  it('uses each user attendance defaults for new records', async () => {
    const { cookie } = await setupAdmin();
    const profile = await jsonRequest('/api/auth/profile', 'PATCH', {
      default_break_minutes: 45,
      default_work_type: 'remote',
    }, cookie);
    expect(profile.status).toBe(200);

    const today = await SELF.fetch(`${origin}/api/attendance/today`, {
      headers: { Cookie: cookie },
    });
    expect(today.status).toBe(200);
    expect(await today.json()).toMatchObject({
      defaults: { break_minutes: 45, work_type: 'remote' },
    });

    const record = await jsonRequest('/api/attendance/2026-07-06', 'PUT', {
      clock_in: '10:00',
      clock_out: '19:00',
    }, cookie);
    expect(record.status).toBe(200);
    expect(await record.json()).toMatchObject({
      record: {
        work_type: 'remote',
        break_minutes: 45,
        transport_fee: 0,
      },
    });
  });

  it('backfills attendance and calculates round-trip fare on the server', async () => {
    const { cookie } = await setupAdmin();
    const office = await jsonRequest('/api/attendance/2026-07-01', 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
      transport_one_way_fee: 220,
      transport_trip_type: 'round_trip',
      memo: '本社勤務',
    }, cookie);
    expect(office.status).toBe(200);
    expect(await office.json()).toMatchObject({
      record: {
        transport_one_way_fee: 220,
        transport_trip_type: 'round_trip',
        transport_fee: 440,
      },
    });

    const paidLeave = await jsonRequest('/api/attendance/2026-07-02', 'PUT', {
      work_type: 'paid_leave',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
      transport_one_way_fee: 999,
      transport_trip_type: 'round_trip',
    }, cookie);
    expect(paidLeave.status).toBe(200);
    expect(await paidLeave.json()).toMatchObject({
      record: { clock_in: null, clock_out: null, break_minutes: 0, transport_fee: 0 },
    });

    const summary = await SELF.fetch(`${origin}/api/attendance/2026/7`, {
      headers: { Cookie: cookie },
    });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      employee_name: '山田 太郎',
      username: 'admin',
      office_days: 1,
      paid_leave_days: 1,
      total_work_minutes: 480,
      total_transport_fee: 440,
    });

    const exportData = await SELF.fetch(`${origin}/api/export/2026/7`, {
      headers: { Cookie: cookie },
    });
    expect(exportData.status).toBe(200);
    expect(await exportData.json()).toMatchObject({
      employee_name: '山田 太郎',
      records: expect.arrayContaining([
        expect.objectContaining({ work_date: '2026-07-01', transport_fee: 440 }),
      ]),
    });

    const invalidDate = await jsonRequest('/api/attendance/2026-02-31', 'PUT', {
      work_type: 'office',
      clock_in: '00:99',
    }, cookie);
    expect(invalidDate.status).toBe(400);

    const invalidClockIn = await jsonRequest('/api/attendance/2026-07-03', 'PUT', {
      work_type: 'office',
      clock_in: '99:00',
    }, cookie);
    expect(invalidClockIn.status).toBe(400);

    const invalidClockOut = await jsonRequest('/api/attendance/2026-07-03', 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '23:60',
    }, cookie);
    expect(invalidClockOut.status).toBe(400);

    const unsupportedField = await jsonRequest('/api/attendance/2026-07-03', 'PUT', {
      work_type: 'office',
      unexpected: true,
    }, cookie);
    expect(unsupportedField.status).toBe(400);
  });

  it('snapshots commute routes and preserves history when profile defaults change', async () => {
    const { cookie } = await setupAdmin();
    const today = await SELF.fetch(`${origin}/api/attendance/today`, {
      headers: { Cookie: cookie },
    });
    expect(today.status).toBe(200);
    expect(await today.json()).toMatchObject({
      defaults: {
        break_minutes: 60,
        work_type: 'office',
        one_way_fare: 220,
        trip_type: 'round_trip',
        transport_mode: 'rail',
        transport_origin: '新宿駅',
        transport_destination: '東京駅',
        transport_fee: 440,
      },
    });

    const firstDay = await jsonRequest('/api/attendance/2026-07-01', 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
    }, cookie);
    expect(firstDay.status).toBe(200);
    expect(await firstDay.json()).toMatchObject({
      record: {
        transport_one_way_fee: 220,
        transport_trip_type: 'round_trip',
        transport_fee: 440,
        transport_mode: 'rail',
        transport_origin: '新宿駅',
        transport_destination: '東京駅',
      },
    });

    const changedDefaults = await jsonRequest('/api/auth/profile', 'PATCH', {
      default_one_way_fare: 310,
      default_trip_type: 'one_way',
      default_transport_mode: 'bus',
      default_transport_origin: '渋谷駅西口',
      default_transport_destination: '品川駅港南口',
    }, cookie);
    expect(changedDefaults.status).toBe(200);

    const memoOnlyCorrection = await jsonRequest('/api/attendance/2026-07-01', 'PUT', {
      memo: '月末確認済み',
    }, cookie);
    expect(memoOnlyCorrection.status).toBe(200);
    expect(await memoOnlyCorrection.json()).toMatchObject({
      record: {
        transport_one_way_fee: 220,
        transport_trip_type: 'round_trip',
        transport_fee: 440,
        transport_mode: 'rail',
        transport_origin: '新宿駅',
        transport_destination: '東京駅',
      },
    });

    const paidLeave = await jsonRequest('/api/attendance/2026-07-02', 'PUT', {
      work_type: 'paid_leave',
      transport_one_way_fee: 999,
      transport_trip_type: 'round_trip',
      transport_mode: 'taxi',
      transport_origin: '保存しない出発地',
      transport_destination: '保存しない到着地',
    }, cookie);
    expect(paidLeave.status).toBe(200);
    expect(await paidLeave.json()).toMatchObject({
      record: {
        transport_one_way_fee: 0,
        transport_trip_type: 'one_way',
        transport_fee: 0,
        transport_mode: 'rail',
        transport_origin: '',
        transport_destination: '',
      },
    });

    const changedBackToOffice = await jsonRequest('/api/attendance/2026-07-02', 'PUT', {
      work_type: 'office',
      clock_in: '09:30',
      clock_out: '18:30',
      break_minutes: 60,
    }, cookie);
    expect(changedBackToOffice.status).toBe(200);
    expect(await changedBackToOffice.json()).toMatchObject({
      record: {
        transport_one_way_fee: 310,
        transport_trip_type: 'one_way',
        transport_fee: 310,
        transport_mode: 'bus',
        transport_origin: '渋谷駅西口',
        transport_destination: '品川駅港南口',
      },
    });

    const overridden = await jsonRequest('/api/attendance/2026-07-03', 'PUT', {
      work_type: 'office',
      clock_in: '08:30',
      clock_out: '17:30',
      break_minutes: 60,
      transport_one_way_fee: 1_250,
      transport_trip_type: 'round_trip',
      transport_mode: 'taxi',
      transport_origin: '自宅',
      transport_destination: '客先',
    }, cookie);
    expect(overridden.status).toBe(200);
    expect(await overridden.json()).toMatchObject({
      record: {
        transport_one_way_fee: 1_250,
        transport_trip_type: 'round_trip',
        transport_fee: 2_500,
        transport_mode: 'taxi',
        transport_origin: '自宅',
        transport_destination: '客先',
      },
    });

    const remote = await jsonRequest('/api/attendance/2026-07-04', 'PUT', {
      work_type: 'remote',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
      transport_one_way_fee: 500,
      transport_trip_type: 'round_trip',
      transport_mode: 'other',
      transport_origin: '自宅',
      transport_destination: '共有オフィス',
    }, cookie);
    expect(remote.status).toBe(200);
    expect(await remote.json()).toMatchObject({
      record: {
        transport_one_way_fee: 0,
        transport_trip_type: 'one_way',
        transport_fee: 0,
        transport_mode: 'rail',
        transport_origin: '',
        transport_destination: '',
      },
    });

    const invalidMode = await jsonRequest('/api/attendance/2026-07-05', 'PUT', {
      work_type: 'office',
      transport_mode: 'plane',
    }, cookie);
    expect(invalidMode.status).toBe(400);
    const tooLongOrigin = await jsonRequest('/api/attendance/2026-07-05', 'PUT', {
      work_type: 'office',
      transport_origin: '駅'.repeat(121),
    }, cookie);
    expect(tooLongOrigin.status).toBe(400);

    const exported = await SELF.fetch(`${origin}/api/export/2026/7`, {
      headers: { Cookie: cookie },
    });
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({
      default_one_way_fare: 310,
      default_trip_type: 'one_way',
      default_transport_mode: 'bus',
      default_transport_origin: '渋谷駅西口',
      default_transport_destination: '品川駅港南口',
      records: expect.arrayContaining([
        expect.objectContaining({
          work_date: '2026-07-01',
          transport_mode: 'rail',
          transport_origin: '新宿駅',
          transport_destination: '東京駅',
          transport_fee: 440,
        }),
        expect.objectContaining({
          work_date: '2026-07-03',
          transport_mode: 'taxi',
          transport_origin: '自宅',
          transport_destination: '客先',
          transport_fee: 2_500,
        }),
      ]),
    });

    const audit = await env.DB.prepare(
      `SELECT after_json FROM audit_logs
       WHERE action = 'attendance_create' AND entity_key = '2026-07-03'
       ORDER BY id DESC LIMIT 1`,
    ).first<{ after_json: string }>();
    expect(JSON.parse(audit?.after_json ?? '{}')).toMatchObject({
      transport_mode: 'taxi',
      transport_one_way_fee: 1_250,
      transport_trip_type: 'round_trip',
      transport_fee: 2_500,
    });
    expect(JSON.parse(audit?.after_json ?? '{}')).not.toHaveProperty('transport_origin');
    expect(JSON.parse(audit?.after_json ?? '{}')).not.toHaveProperty('transport_destination');
  });

  it('closes a previous-day overnight shift without accepting a 24-hour shift', async () => {
    // The session must be created against the real clock: createSession derives
    // expires_at from Date.now(), but the auth check compares it with SQLite's
    // datetime('now'), which fake timers do not touch. Setting up under a mocked
    // past date would mint a session that is already expired once real time
    // passes the mock plus SESSION_TTL_SECONDS.
    const { cookie } = await setupAdmin();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00Z')); // 09:00 JST
    const yesterday = previousDate(todayJST());
    await env.DB.prepare(
      `INSERT INTO attendance (
         user_id, work_date, work_type, clock_in, clock_out, break_minutes,
         transport_fee, transport_one_way_fee, transport_trip_type, memo
       ) VALUES (1, ?, 'office', '23:00', NULL, 0, 0, 0, 'round_trip', '')`,
    ).bind(yesterday).run();
    await env.DB.prepare(
      `INSERT INTO attendance (
         user_id, work_date, work_type, clock_in, clock_out, break_minutes,
         transport_fee, transport_one_way_fee, transport_trip_type, memo
       ) VALUES (1, ?, 'paid_leave', NULL, NULL, 0, 0, 0, 'round_trip', '')`,
    ).bind(todayJST()).run();

    const todayResp = await SELF.fetch(`${origin}/api/attendance/today`, {
      headers: { Cookie: cookie },
    });
    expect(todayResp.status).toBe(200);
    const todayData = await todayResp.json<{ active_record: Record<string, unknown> | null }>();
    expect(todayData.active_record).toMatchObject({ work_date: yesterday, clock_in: '23:00' });

    const closed = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '01:00',
    }, cookie);
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({
      record: { work_date: yesterday, clock_in: '23:00', clock_out: '01:00' },
    });

    await env.DB.prepare('UPDATE attendance SET clock_out = NULL WHERE user_id = 1 AND work_date = ?')
      .bind(yesterday)
      .run();
    const tooLong = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '23:00',
    }, cookie);
    expect(tooLong.status).toBe(409);
  });

  it('enforces open shift invariant and protects against concurrent open shifts', async () => {
    const { cookie } = await setupAdmin();
    const yesterday = previousDate(todayJST());

    // Insert open shift on yesterday
    await env.DB.prepare(
      `INSERT INTO attendance (
         user_id, work_date, work_type, clock_in, clock_out, break_minutes,
         transport_fee, transport_one_way_fee, transport_trip_type, memo
       ) VALUES (1, ?, 'office', '22:00', NULL, 60, 0, 0, 'round_trip', '')`,
    ).bind(yesterday).run();

    // Trying to clock-in today when yesterday is still open should return 409
    const conflictClockIn = await jsonRequest('/api/attendance/clock-in', 'POST', {}, cookie);
    expect(conflictClockIn.status).toBe(409);
    expect(await conflictClockIn.json()).toMatchObject({
      error: expect.stringContaining(yesterday),
    });

    // Saving an open shift on another date via PUT /:date is allowed and independent (does not block or get blocked)
    const independentPut = await jsonRequest('/api/attendance/2026-07-10', 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
    }, cookie);
    expect(independentPut.status).toBe(200);
    expect(await independentPut.json()).toMatchObject({
      record: { work_date: '2026-07-10', clock_in: '09:00', clock_out: null },
    });
  });

  it('rejects invalid same-day clock-out times and handles stale open shifts', async () => {
    const { cookie } = await setupAdmin();
    const today = todayJST();

    // Clock in at 20:00 today
    const inRes = await jsonRequest('/api/attendance/clock-in', 'POST', {
      clock_in: '20:00',
    }, cookie);
    expect(inRes.status).toBe(200);

    // Submitting 10:00 clock-out on the same day should fail (clockOut < clockIn on same day)
    const invalidClockOut = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '10:00',
    }, cookie);
    expect(invalidClockOut.status).toBe(400);
    expect(await invalidClockOut.json()).toMatchObject({
      error: expect.stringContaining('退勤時刻が出勤時刻より前です'),
    });

    // Clean up today's record and insert a stale open shift from 3 days ago
    await env.DB.prepare('DELETE FROM attendance WHERE user_id = 1').run();
    const staleDate = previousDate(previousDate(today));
    await env.DB.prepare(
      `INSERT INTO attendance (
         user_id, work_date, work_type, clock_in, clock_out, break_minutes,
         transport_fee, transport_one_way_fee, transport_trip_type, memo
       ) VALUES (1, ?, 'office', '23:00', NULL, 0, 0, 0, 'round_trip', '')`,
    ).bind(staleDate).run();

    // /today should NOT return the stale open record as active_record (strictly scoped to today/yesterday)
    const todayCheck = await SELF.fetch(`${origin}/api/attendance/today`, {
      headers: { Cookie: cookie },
    });
    expect((await todayCheck.json<{ active_record: Record<string, unknown> | null }>()).active_record).toBeNull();

    // User can clock-in today normally without being blocked by 3-day-old stale shifts
    const clockInToday = await jsonRequest('/api/attendance/clock-in', 'POST', {
      clock_in: '09:00',
    }, cookie);
    expect(clockInToday.status).toBe(200);
  });

  it('does not allow historical incomplete shifts to block today while enforcing yesterday overnight shift active boundaries', async () => {
    // The session must be created against the real clock: createSession derives
    // expires_at from Date.now(), but the auth check compares it with SQLite's
    // datetime('now'), which fake timers do not touch. Setting up under a mocked
    // past date would mint a session that is already expired once real time
    // passes the mock plus SESSION_TTL_SECONDS.
    const { cookie } = await setupAdmin();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00Z')); // 09:00 JST
    const today = todayJST();
    const yesterday = previousDate(today);

    // 1. Insert historical incomplete record from June (2026-06-18)
    await env.DB.prepare('DELETE FROM attendance WHERE user_id = 1').run();
    await env.DB.prepare(
      `INSERT INTO attendance (
         user_id, work_date, work_type, clock_in, clock_out, break_minutes,
         transport_fee, transport_one_way_fee, transport_trip_type, memo
       ) VALUES (1, '2026-06-18', 'office', '09:00', NULL, 60, 0, 0, 'round_trip', '')`,
    ).run();

    // 2. GET /api/attendance/today: active_record must be null (June 18 does not leak into today)
    const todayResp = await SELF.fetch(`${origin}/api/attendance/today`, {
      headers: { Cookie: cookie },
    });
    expect(todayResp.status).toBe(200);
    const todayData = await todayResp.json<{ active_record: Record<string, unknown> | null }>();
    expect(todayData.active_record).toBeNull();

    // 3. POST /api/attendance/clock-in on today succeeds (not blocked by June 18)
    const todayClockIn = await jsonRequest('/api/attendance/clock-in', 'POST', {
      clock_in: '10:00',
    }, cookie);
    expect(todayClockIn.status).toBe(200);
    expect(await todayClockIn.json()).toMatchObject({
      record: { work_date: today, clock_in: '10:00', clock_out: null },
    });

    // 4. GET /api/attendance/2026/6: June summary still accurately displays 2026-06-18 as incomplete
    const juneSummaryResp = await SELF.fetch(`${origin}/api/attendance/2026/6`, {
      headers: { Cookie: cookie },
    });
    expect(juneSummaryResp.status).toBe(200);
    const juneData = await juneSummaryResp.json<{ records: Array<{ work_date: string; clock_in: string | null; clock_out: string | null }> }>();
    const june18 = juneData.records.find((r) => r.work_date === '2026-06-18');
    expect(june18).toBeDefined();
    expect(june18?.clock_in).toBe('09:00');
    expect(june18?.clock_out).toBeNull();

    // 5. Historical editing via PUT /:date is not blocked by 2026-06-18
    const historicalPut = await jsonRequest('/api/attendance/2026-08-13', 'PUT', {
      work_type: 'office',
      clock_in: '23:04',
    }, cookie);
    expect(historicalPut.status).toBe(200);
    expect(await historicalPut.json()).toMatchObject({
      record: { work_date: '2026-08-13', clock_in: '23:04', clock_out: null },
    });

    // 6. Test yesterday active shift (<= 18h) boundary:
    await env.DB.prepare('DELETE FROM attendance WHERE user_id = 1').run();
    // Simulate overnight shift from yesterday (e.g. 23:00)
    await env.DB.prepare(
      `INSERT INTO attendance (
         user_id, work_date, work_type, clock_in, clock_out, break_minutes,
         transport_fee, transport_one_way_fee, transport_trip_type, memo
       ) VALUES (1, ?, 'office', '23:00', NULL, 60, 0, 0, 'round_trip', '')`,
    ).bind(yesterday).run();

    // GET /today on today sees yesterday as active_record (if within 18h)
    const overnightCheck = await SELF.fetch(`${origin}/api/attendance/today`, {
      headers: { Cookie: cookie },
    });
    const overnightData = await overnightCheck.json<{ active_record: Record<string, unknown> | null }>();
    expect(overnightData.active_record).toMatchObject({ work_date: yesterday, clock_in: '23:00' });

    // Clocking in today is blocked with 409 while yesterday overnight active shift is still open
    const blockedClockIn = await jsonRequest('/api/attendance/clock-in', 'POST', {
      clock_in: '08:00',
    }, cookie);
    expect(blockedClockIn.status).toBe(409);
    expect(await blockedClockIn.json()).toMatchObject({
      error: expect.stringContaining(yesterday),
    });

    // PUT open shift on today is also mutually exclusive with active yesterday shift
    const blockedTodayPut = await jsonRequest(`/api/attendance/${today}`, 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
    }, cookie);
    expect(blockedTodayPut.status).toBe(409);

    // Clock out yesterday's overnight shift
    const overnightClockOut = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '07:00',
      break_minutes: 60,
    }, cookie);
    expect(overnightClockOut.status).toBe(200);
    expect(await overnightClockOut.json()).toMatchObject({
      record: { work_date: yesterday, clock_in: '23:00', clock_out: '07:00' },
    });

    // 7. Stale shift from yesterday (> 18h, e.g. yesterday 00:00 to now):
    // Insert a shift from yesterday morning that is > 18h old
    await env.DB.prepare('DELETE FROM attendance WHERE user_id = 1').run();
    await env.DB.prepare(
      `INSERT INTO attendance (
         user_id, work_date, work_type, clock_in, clock_out, break_minutes,
         transport_fee, transport_one_way_fee, transport_trip_type, memo
       ) VALUES (1, ?, 'office', '00:01', NULL, 60, 0, 0, 'round_trip', '')`,
    ).bind(yesterday).run();

    // The shift is 32h59m old: it is not eligible for ordinary clock-out,
    // but it still blocks a second clock-in until Calendar correction.
    const staleOvernightCheck = await SELF.fetch(`${origin}/api/attendance/today`, {
      headers: { Cookie: cookie },
    });
    expect(staleOvernightCheck.status).toBe(200);
    const staleData = await staleOvernightCheck.json<{
      active_record: Record<string, unknown> | null;
      stale_record: Record<string, unknown> | null;
    }>();
    expect(staleData.active_record).toBeNull();
    expect(staleData.stale_record).toMatchObject({ work_date: yesterday, clock_in: '00:01' });

    const blockedByStaleClockIn = await jsonRequest('/api/attendance/clock-in', 'POST', {
      clock_in: '09:00',
    }, cookie);
    expect(blockedByStaleClockIn.status).toBe(409);
    expect(await blockedByStaleClockIn.json()).toMatchObject({
      error: expect.stringContaining('カレンダー'),
    });

    const blockedStaleClockOut = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '09:00',
    }, cookie);
    expect(blockedStaleClockOut.status).toBe(409);
    expect(await blockedStaleClockOut.json()).toMatchObject({
      error: expect.stringContaining('カレンダー'),
    });

    const blockedTodayPutByStale = await jsonRequest(`/api/attendance/${today}`, 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
    }, cookie);
    expect(blockedTodayPutByStale.status).toBe(409);
    expect(await blockedTodayPutByStale.json()).toMatchObject({
      error: expect.stringContaining('カレンダー'),
    });

    const correctedStaleRecord = await jsonRequest(`/api/attendance/${yesterday}`, 'PUT', {
      work_type: 'office',
      clock_in: '00:01',
      clock_out: '18:00',
      break_minutes: 60,
    }, cookie);
    expect(correctedStaleRecord.status).toBe(200);

    const clockInAfterCorrection = await jsonRequest('/api/attendance/clock-in', 'POST', {
      clock_in: '09:00',
    }, cookie);
    expect(clockInAfterCorrection.status).toBe(200);
  });

  it('validates shift span limits and break duration', async () => {
    const { cookie } = await setupAdmin();

    // Shift span exceeding 18 hours (10:00 -> 09:59 overnight = 23h59m) should be rejected
    const over18h = await jsonRequest('/api/attendance/2026-07-06', 'PUT', {
      work_type: 'office',
      clock_in: '10:00',
      clock_out: '09:59',
      break_minutes: 60,
    }, cookie);
    expect(over18h.status).toBe(400);
    expect(await over18h.json()).toMatchObject({
      error: expect.stringContaining('18時間'),
    });

    // Break exceeding shift span (09:00 -> 10:00 = 60min, break = 120min) should be rejected
    const breakTooLong = await jsonRequest('/api/attendance/2026-07-06', 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '10:00',
      break_minutes: 120,
    }, cookie);
    expect(breakTooLong.status).toBe(400);
    expect(await breakTooLong.json()).toMatchObject({
      error: expect.stringContaining('休憩時間'),
    });

    // Short shift clock-out with break_minutes update (10:00 -> 10:30, initial break=60, update to break=0)
    await env.DB.prepare('DELETE FROM attendance WHERE user_id = 1').run();
    await jsonRequest('/api/attendance/clock-in', 'POST', {
      clock_in: '10:00',
      break_minutes: 60,
    }, cookie);
    const shortShiftOut = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '10:30',
      break_minutes: 0,
    }, cookie);
    expect(shortShiftOut.status).toBe(200);
    expect(await shortShiftOut.json()).toMatchObject({
      record: {
        clock_in: '10:00',
        clock_out: '10:30',
        break_minutes: 0,
      },
    });

    // Backward compatibility: clock-out without break_minutes preserves initial break_minutes
    await env.DB.prepare('DELETE FROM attendance WHERE user_id = 1').run();
    await jsonRequest('/api/attendance/clock-in', 'POST', {
      clock_in: '10:00',
      break_minutes: 45,
    }, cookie);
    const compatOut = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '18:00',
    }, cookie);
    expect(compatOut.status).toBe(200);
    expect(await compatOut.json()).toMatchObject({
      record: {
        clock_in: '10:00',
        clock_out: '18:00',
        break_minutes: 45,
      },
    });

    // Clock-out with break_minutes > span should fail with 400
    await env.DB.prepare('DELETE FROM attendance WHERE user_id = 1').run();
    await jsonRequest('/api/attendance/clock-in', 'POST', {
      clock_in: '10:00',
      break_minutes: 15,
    }, cookie);
    const breakExceedsSpan = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '10:30',
      break_minutes: 45,
    }, cookie);
    expect(breakExceedsSpan.status).toBe(400);
    expect(await breakExceedsSpan.json()).toMatchObject({
      error: expect.stringContaining('休憩時間'),
    });
  });

  it('fails monthly reports closed when authoritative holiday data is unavailable', async () => {
    const { cookie } = await setupAdmin();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('temporarily unavailable', { status: 503 }),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await SELF.fetch(`${origin}/api/export/2015/1`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('2015'),
      });
      const cachedFailure = await SELF.fetch(`${origin}/api/export/2015/1`, {
        headers: { Cookie: cookie },
      });
      expect(cachedFailure.status).toBe(503);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  it('enforces admin authorization and same-origin writes', async () => {
    const { cookie } = await setupAdmin();
    await expect(
      env.DB.prepare('DELETE FROM users WHERE id = 1').run(),
    ).rejects.toThrow(/cannot delete last administrator/);
    const crossSite = await jsonRequest('/api/admin/users', 'POST', {
      username: 'worker',
      display_name: '一般 社員',
      password: 'worker-password-123',
    }, cookie, 'https://evil.example');
    expect(crossSite.status).toBe(403);

    const created = await jsonRequest('/api/admin/users', 'POST', {
      username: 'worker',
      display_name: '一般 社員',
      password: 'worker-password-123',
      default_one_way_fare: 180,
      default_trip_type: 'round_trip',
      default_transport_mode: 'rail',
      default_transport_origin: '横浜駅',
      default_transport_destination: '川崎駅',
    }, cookie);
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ user: { id: number } & Record<string, unknown> }>();
    expect(createdBody.user).toMatchObject({
      default_transport_mode: 'rail',
      default_transport_origin: '横浜駅',
      default_transport_destination: '川崎駅',
    });

    const updated = await jsonRequest(`/api/admin/users/${createdBody.user.id}`, 'PATCH', {
      default_transport_mode: 'other',
      default_transport_origin: '自宅',
      default_transport_destination: '営業所',
    }, cookie);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      user: {
        username: 'worker',
        default_transport_mode: 'other',
        default_transport_origin: '自宅',
        default_transport_destination: '営業所',
      },
    });

    const selfDelete = await jsonRequest('/api/admin/users/1', 'DELETE', {}, cookie);
    expect(selfDelete.status).toBe(400);
    // The admin reset path must not become a way around re-authentication.
    const selfReset = await jsonRequest('/api/admin/users/1/password', 'POST', {
      new_password: 'another-password-123',
    }, cookie);
    expect(selfReset.status).toBe(400);
    const stillSignedIn = await SELF.fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(stillSignedIn.status).toBe(200);
    const deleted = await jsonRequest(`/api/admin/users/${createdBody.user.id}`, 'DELETE', {}, cookie);
    expect(deleted.status).toBe(200);
  });

  it('isolates each user and revokes sessions after admin reset or deletion', async () => {
    const { cookie: adminCookie } = await setupAdmin();
    const created = await jsonRequest('/api/admin/users', 'POST', {
      username: 'worker',
      display_name: '一般 社員',
      password: 'worker-password-123',
    }, adminCookie);
    const workerId = (await created.json<{ user: { id: number } }>()).user.id;

    const login = await jsonRequest('/api/auth/login', 'POST', {
      username: 'worker',
      password: 'worker-password-123',
    });
    expect(login.status).toBe(200);
    const workerCookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0];

    const forbidden = await SELF.fetch(`${origin}/api/admin/users`, {
      headers: { Cookie: workerCookie },
    });
    expect(forbidden.status).toBe(403);

    const reset = await jsonRequest(`/api/admin/users/${workerId}/password`, 'POST', {
      new_password: 'worker-password-456',
    }, adminCookie);
    expect(reset.status).toBe(200);
    const resetRevoked = await SELF.fetch(`${origin}/api/auth/me`, {
      headers: { Cookie: workerCookie },
    });
    expect(resetRevoked.status).toBe(401);
    const oldWorkerPassword = await jsonRequest('/api/auth/login', 'POST', {
      username: 'worker',
      password: 'worker-password-123',
    });
    expect(oldWorkerPassword.status).toBe(401);
    const resetLogin = await jsonRequest('/api/auth/login', 'POST', {
      username: 'worker',
      password: 'worker-password-456',
    });
    expect(resetLogin.status).toBe(200);
    const resetWorkerCookie = (resetLogin.headers.get('set-cookie') ?? '').split(';', 1)[0];

    await jsonRequest('/api/attendance/2026-07-06', 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
      transport_one_way_fee: 220,
      transport_trip_type: 'round_trip',
    }, adminCookie);
    const workerSummary = await SELF.fetch(`${origin}/api/attendance/2026/7`, {
      headers: { Cookie: resetWorkerCookie },
    });
    expect(await workerSummary.json()).toMatchObject({ office_days: 0, total_transport_fee: 0 });

    const removed = await jsonRequest(`/api/admin/users/${workerId}`, 'DELETE', {}, adminCookie);
    expect(removed.status).toBe(200);
    const revoked = await SELF.fetch(`${origin}/api/auth/me`, {
      headers: { Cookie: resetWorkerCookie },
    });
    expect(revoked.status).toBe(401);
  });

  it('slides an in-use session forward without passing its absolute lifetime', async () => {
    const { cookie } = await setupAdmin();
    const me = () => SELF.fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
    const sessionCheck = (condition: string) => env.DB.prepare(
      `SELECT (${condition}) AS ok FROM sessions`,
    ).first<{ ok: number }>();

    // More than half of the 7-day TTL left: nothing to renew.
    const fresh = await me();
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('set-cookie')).toBeNull();

    // Less than half left: the same token comes back with a full TTL.
    await env.DB.prepare("UPDATE sessions SET expires_at = datetime('now', '+1 day')").run();
    const renewed = await me();
    expect(renewed.status).toBe(200);
    const renewedCookie = renewed.headers.get('set-cookie') ?? '';
    expect(renewedCookie.split(';', 1)[0]).toBe(cookie);
    expect(Number(/Max-Age=(\d+)/.exec(renewedCookie)?.[1])).toBeGreaterThan(6 * 24 * 60 * 60);
    expect((await sessionCheck("expires_at > datetime('now', '+6 days')"))?.ok).toBe(1);

    // Near the absolute lifetime the extension stops at created_at + 30 days.
    await env.DB.prepare(
      "UPDATE sessions SET created_at = datetime('now', '-29 days'), expires_at = datetime('now', '+1 hour')",
    ).run();
    expect((await me()).status).toBe(200);
    expect((await sessionCheck(
      "expires_at > datetime('now', '+23 hours') AND expires_at <= datetime('now', '+1 day', '+1 minute')",
    ))?.ok).toBe(1);

    // Past it, the session runs out on its current expiry.
    await env.DB.prepare(
      "UPDATE sessions SET created_at = datetime('now', '-31 days'), expires_at = datetime('now', '+1 hour')",
    ).run();
    const beyond = await me();
    expect(beyond.status).toBe(200);
    expect(beyond.headers.get('set-cookie')).toBeNull();
    expect((await sessionCheck("expires_at <= datetime('now', '+1 hour')"))?.ok).toBe(1);
  });

  it('returns JSON 404 and API security headers', async () => {
    const response = await SELF.fetch(`${origin}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toMatchObject({ error: 'APIが見つかりません' });
  });

  it('keeps audit data in D1 instead of storing generated files', async () => {
    const { cookie } = await setupAdmin();
    await jsonRequest('/api/attendance/2026-07-03', 'PUT', {
      work_type: 'remote',
      clock_in: '09:30',
      clock_out: '18:00',
      break_minutes: 45,
      transport_one_way_fee: 500,
      transport_trip_type: 'round_trip',
    }, cookie);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM audit_logs')
      .first<{ count: number }>();
    expect(count?.count).toBeGreaterThanOrEqual(2);
  });

  it('rejects clock punches on a future date while still allowing a plan', async () => {
    const { cookie } = await setupAdmin();

    const completedShift = await jsonRequest('/api/attendance/2099-12-31', 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
    }, cookie);
    expect(completedShift.status).toBe(400);
    expect(await completedShift.json()).toMatchObject({
      error: expect.stringContaining('未来の日付'),
    });

    const openShift = await jsonRequest('/api/attendance/2099-12-31', 'PUT', {
      work_type: 'remote',
      clock_in: '09:00',
    }, cookie);
    expect(openShift.status).toBe(400);

    const stored = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM attendance WHERE work_date = ?',
    ).bind('2099-12-31').first<{ count: number }>();
    expect(stored?.count).toBe(0);

    // Scheduling a non-working day ahead of time carries no worked minutes and
    // stays allowed.
    const plannedLeave = await jsonRequest('/api/attendance/2099-12-31', 'PUT', {
      work_type: 'paid_leave',
    }, cookie);
    expect(plannedLeave.status).toBe(200);

    // Today is not the future; the boundary must stay inclusive.
    const todayShift = await jsonRequest(`/api/attendance/${todayJST()}`, 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
    }, cookie);
    expect(todayShift.status).toBe(200);
  });

  it('treats an explicitly cleared one-way fare as zero, not as the profile default', async () => {
    const { cookie } = await setupAdmin();

    const omitted = await jsonRequest('/api/attendance/2026-07-06', 'PUT', {
      work_type: 'office',
      transport_trip_type: 'one_way',
    }, cookie);
    expect(omitted.status).toBe(200);
    expect(await omitted.json()).toMatchObject({
      record: { transport_one_way_fee: 220, transport_fee: 220 },
    });

    const cleared = await jsonRequest('/api/attendance/2026-07-07', 'PUT', {
      work_type: 'office',
      transport_one_way_fee: null,
      transport_trip_type: 'one_way',
    }, cookie);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      record: { transport_one_way_fee: 0, transport_fee: 0 },
    });
  });

  it('writes one created_at format for the bootstrap admin and for later users', async () => {
    const { cookie } = await setupAdmin();
    const created = await jsonRequest('/api/admin/users', 'POST', {
      username: 'worker1',
      display_name: '作業 花子',
      password: 'strong-password-123',
    }, cookie);
    expect(created.status).toBe(201);

    const rows = await env.DB.prepare('SELECT username, created_at FROM users ORDER BY id')
      .all<{ username: string; created_at: string }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }

    // The setup audit row correlates on username + created_at inside one batch,
    // so it must still land with the SQLite-formatted timestamp.
    const setupAudit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'initial_setup'",
    ).first<{ count: number }>();
    expect(setupAudit?.count).toBe(1);
  });
});


describe('Attendance optimistic concurrency and memo validation', () => {
  async function write(cookie: string, method: string, tag?: string, body: Record<string, unknown> = { work_type: 'holiday' }, date = '2026-07-08') {
    const headers: Record<string, string> = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    if (tag === '*') headers['If-None-Match'] = '*';
    else if (tag) headers['If-Match'] = tag;
    return SELF.fetch(`${origin}/api/attendance/${date}`, {
      method, headers, body: method === 'DELETE' ? undefined : JSON.stringify(body),
    });
  }

  async function savedTag(response: Response) {
    expect(response.status).toBe(200);
    const { record } = await response.json<{ record: { id: number; revision: number } }>();
    return `"${record.id}:${record.revision}"`;
  }

  it('rejects stale saves and deletes without changing newer data or adding audit events', async () => {
    const { cookie } = await setupAdmin();
    const original = await savedTag(await write(cookie, 'PUT', '*', { work_type: 'office', clock_in: '10:00', clock_out: '19:00' }));
    const updated = await savedTag(await write(cookie, 'PUT', original, { clock_out: '20:00', memo: 'new' }));
    expect(updated).not.toBe(original);
    expect((await write(cookie, 'PUT', original, { clock_out: '19:00', memo: 'stale' })).status).toBe(412);
    expect((await write(cookie, 'DELETE', original)).status).toBe(412);
    expect(await env.DB.prepare("SELECT clock_out, memo, revision FROM attendance WHERE work_date = '2026-07-08'").first()).toMatchObject({ clock_out: '20:00', memo: 'new', revision: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'attendance'").first()).toMatchObject({ count: 2 });
  });

  it('requires a precondition and permits only one concurrent create or update', async () => {
    const { cookie } = await setupAdmin();
    expect((await write(cookie, 'PUT')).status).toBe(428);
    expect((await write(cookie, 'DELETE')).status).toBe(428);
    const creates = await Promise.all([write(cookie, 'PUT', '*'), write(cookie, 'PUT', '*')]);
    expect(creates.map((r) => r.status).sort()).toEqual([200, 412]);
    const tag = await savedTag(creates.find((r) => r.status === 200)!);
    const updates = await Promise.all([
      write(cookie, 'PUT', tag, { memo: 'first' }), write(cookie, 'PUT', tag, { memo: 'second' }),
    ]);
    expect(updates.map((r) => r.status).sort()).toEqual([200, 412]);
  });

  it('does not resurrect a deleted row or accept a tag from before recreation', async () => {
    const { cookie } = await setupAdmin();
    const old = await savedTag(await write(cookie, 'PUT', '*'));
    expect((await write(cookie, 'DELETE', old)).status).toBe(200);
    expect((await write(cookie, 'PUT', old)).status).toBe(412);
    const recreated = await savedTag(await write(cookie, 'PUT', '*'));
    expect(recreated).not.toBe(old);
    expect((await write(cookie, 'PUT', old)).status).toBe(412);
    expect((await write(cookie, 'DELETE', old)).status).toBe(412);
    expect((await write(cookie, 'DELETE', recreated)).status).toBe(200);
  });

  it('changes the version on clock-out so an earlier editor cannot undo the punch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T10:00:00+09:00'));
    const { cookie } = await setupAdmin();
    const created = await jsonRequest('/api/attendance/clock-in', 'POST', { clock_in: '09:00' }, cookie);
    const tag = await savedTag(created);
    const closed = await jsonRequest('/api/attendance/clock-out', 'POST', { clock_out: '10:00', break_minutes: 0 }, cookie);
    expect(await savedTag(closed)).not.toBe(tag);
    expect((await write(cookie, 'PUT', tag, { clock_out: null }, todayJST())).status).toBe(412);
  });

  it('preserves multiline notes, normalizes CRLF and rejects other controls accurately', async () => {
    const { cookie } = await setupAdmin();
    const tag = await savedTag(await write(cookie, 'PUT', '*', { work_type: 'holiday', memo: '午前会議\r\n午後作業' }));
    expect(await env.DB.prepare("SELECT memo FROM attendance WHERE work_date = '2026-07-08'").first()).toMatchObject({ memo: '午前会議\n午後作業' });
    const control = await write(cookie, 'PUT', tag, { memo: 'bad\u0000note' });
    expect(control.status).toBe(400);
    expect(await control.json()).toMatchObject({ error: '備考に無効な文字が含まれています' });
    expect((await write(cookie, 'PUT', tag, { memo: 'あ'.repeat(501) })).status).toBe(400);
    expect((await write(cookie, 'PUT', tag, { memo: '' })).status).toBe(200);
  });
});
