import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import type { Attendance, TransportMode, TransportTripType, WorkType } from '../types';
import { getUserAttendanceDefaults, getUserCommuteDefaults } from '../utils/config';
import { buildHolidayMap, getHolidayData } from '../utils/holidays';
import { buildMonthlySummary } from '../utils/summary';
import {
  elapsedShiftMinutes,
  MAX_SHIFT_MINUTES,
  nowTimeJST,
  previousDate,
  shiftSpanMinutes,
  timeToMinutes,
  todayJST,
} from '../utils/time';
import {
  assertOnlyKeys,
  boundedInteger,
  dateValue,
  nullableBoundedInteger,
  nullableTime,
  optionalString,
  readJsonObject,
  RequestValidationError,
  transportModeValue,
  tripTypeValue,
  workTypeValue,
  yearMonthValues,
} from '../utils/validation';

const attendance = new Hono<AuthEnv>();
attendance.use('*', authMiddleware);

function fareTotal(oneWayFare: number, tripType: TransportTripType): number {
  return oneWayFare * (tripType === 'round_trip' ? 2 : 1);
}

/**
 * `undefined` means the caller omitted the field, so the stored or profile
 * default applies. An explicit `null` (or an empty string) is the caller
 * clearing the fare and must resolve to 0 instead of silently re-applying a
 * default the caller just removed.
 */
function resolveOneWayFare(requested: number | null | undefined, fallback: number): number {
  if (requested === undefined) return fallback;
  return requested ?? 0;
}

function isClockable(workType: WorkType): workType is 'office' | 'remote' {
  return workType === 'office' || workType === 'remote';
}

// Only today or yesterday can affect Today view. Older incomplete records are
// historical anomalies displayed in Calendar/Summary and must not block today.
async function findRecentOpenAttendance(db: D1Database, userId: number, today: string): Promise<Attendance | null> {
  const yesterday = previousDate(today);
  return db.prepare(
    `SELECT * FROM attendance
     WHERE user_id = ?
       AND work_date IN (?, ?)
       AND clock_in IS NOT NULL
       AND clock_out IS NULL
       AND work_type IN ('office', 'remote')
     ORDER BY work_date DESC
     LIMIT 1`,
  )
    .bind(userId, today, yesterday)
    .first<Attendance>();
}

function isStaleRecentAttendance(
  record: Pick<Attendance, 'work_date' | 'clock_in'> | null,
  today: string,
  currentTime: string,
): boolean {
  return Boolean(
    record?.clock_in
    && record.work_date === previousDate(today)
    && elapsedShiftMinutes(record.work_date, record.clock_in, today, currentTime) > MAX_SHIFT_MINUTES,
  );
}

function openAttendanceConflictMessage(
  record: Pick<Attendance, 'work_date'>,
  stale: boolean,
): string {
  return stale
    ? `${record.work_date} の未退勤記録があります。カレンダーから記録を修正してください`
    : `${record.work_date} の勤務がまだ退勤されていません。先に退勤または記録修正をしてください`;
}

attendance.get('/today', async (c) => {
  const user = c.get('user');
  const now = new Date();
  const date = todayJST(now);
  const currentTime = nowTimeJST(now);
  const [record, recentOpenRecord, holidayData] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?')
      .bind(user.id, date)
      .first<Attendance>(),
    findRecentOpenAttendance(c.env.DB, user.id, date),
    getHolidayData(c.env, Number(date.slice(0, 4))),
  ]);
  const staleRecord = isStaleRecentAttendance(recentOpenRecord, date, currentTime)
    ? recentOpenRecord
    : null;
  const activeRecord = staleRecord ? null : recentOpenRecord;
  const holidayName = buildHolidayMap(holidayData.holidays).get(date) ?? null;
  const commuteDefaults = getUserCommuteDefaults(c.env, user);
  const attendanceDefaults = getUserAttendanceDefaults(c.env, user);
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();

  return c.json({
    date,
    day_of_week: dayOfWeek,
    is_holiday: holidayName !== null,
    holiday_name: holidayName,
    is_weekend: dayOfWeek === 0 || dayOfWeek === 6,
    record: record ?? null,
    active_record: activeRecord ?? null,
    stale_record: staleRecord,
    defaults: {
      break_minutes: attendanceDefaults.break_minutes,
      work_type: attendanceDefaults.work_type,
      one_way_fare: commuteDefaults.one_way_fare,
      trip_type: commuteDefaults.trip_type,
      transport_mode: commuteDefaults.transport_mode,
      transport_origin: commuteDefaults.transport_origin,
      transport_destination: commuteDefaults.transport_destination,
      transport_fee: fareTotal(commuteDefaults.one_way_fare, commuteDefaults.trip_type),
    },
    holiday_data: {
      source: holidayData.source,
      complete: holidayData.complete,
      synced_at: holidayData.synced_at,
    },
  });
});

attendance.post('/clock-in', async (c) => {
  const user = c.get('user');
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, [
    'work_type',
    'clock_in',
    'break_minutes',
    'transport_trip_type',
    'transport_mode',
    'transport_origin',
    'transport_destination',
    'transport_one_way_fee',
  ]);
  const attendanceDefaults = getUserAttendanceDefaults(c.env, user);
  const workType = workTypeValue(body.work_type, attendanceDefaults.work_type);
  if (!isClockable(workType)) {
    throw new RequestValidationError('打刻は出社または在宅勤務のみ選択可能です');
  }

  const now = new Date();
  const date = todayJST(now);
  const currentTime = nowTimeJST(now);
  const existingOpen = await findRecentOpenAttendance(c.env.DB, user.id, date);
  if (existingOpen) {
    return c.json({
      error: openAttendanceConflictMessage(
        existingOpen,
        isStaleRecentAttendance(existingOpen, date, currentTime),
      ),
    }, 409);
  }

  const clockIn = nullableTime(body.clock_in, '出勤時刻') ?? currentTime;

  const defaults = getUserCommuteDefaults(c.env, user);
  const breakMinutes = boundedInteger(
    body.break_minutes,
    '休憩（分）',
    0,
    480,
    attendanceDefaults.break_minutes,
  );
  const requestedTripType = body.transport_trip_type === undefined
    ? undefined
    : tripTypeValue(body.transport_trip_type);
  const requestedTransportMode = body.transport_mode === undefined
    ? undefined
    : transportModeValue(body.transport_mode);
  const requestedOrigin = optionalString(body.transport_origin, '出発地', 120);
  const requestedDestination = optionalString(body.transport_destination, '到着地', 120);
  const requestedFare = nullableBoundedInteger(
    body.transport_one_way_fee,
    '片道交通費',
    0,
    100_000,
  );
  const tripType: TransportTripType = workType === 'office'
    ? (requestedTripType ?? defaults.trip_type)
    : 'one_way';
  const transportMode: TransportMode = workType === 'office'
    ? (requestedTransportMode ?? defaults.transport_mode)
    : 'rail';
  const transportOrigin = workType === 'office'
    ? (requestedOrigin ?? defaults.transport_origin)
    : '';
  const transportDestination = workType === 'office'
    ? (requestedDestination ?? defaults.transport_destination)
    : '';
  const oneWayFare = workType === 'office'
    ? resolveOneWayFare(requestedFare, defaults.one_way_fare)
    : 0;
  const totalFare = workType === 'office' ? fareTotal(oneWayFare, tripType) : 0;

  const upsert = c.env.DB.prepare(
    `INSERT INTO attendance (
       user_id, work_date, work_type, clock_in, clock_out, break_minutes,
       transport_fee, transport_one_way_fee, transport_trip_type,
       transport_mode, transport_origin, transport_destination, memo
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '')
     ON CONFLICT(user_id, work_date) DO UPDATE SET
       work_type = excluded.work_type,
       clock_in = excluded.clock_in,
       clock_out = NULL,
       break_minutes = excluded.break_minutes,
       transport_fee = excluded.transport_fee,
       transport_one_way_fee = excluded.transport_one_way_fee,
       transport_trip_type = excluded.transport_trip_type,
       transport_mode = excluded.transport_mode,
       transport_origin = excluded.transport_origin,
       transport_destination = excluded.transport_destination,
       updated_at = datetime('now')
     WHERE attendance.clock_in IS NULL AND attendance.clock_out IS NULL
     RETURNING *`,
  ).bind(
    user.id,
    date,
    workType,
    clockIn,
    breakMinutes,
    totalFare,
    oneWayFare,
    tripType,
    transportMode,
    transportOrigin,
    transportDestination,
  );
  const record = await upsert.first<Attendance>();

  if (!record) return c.json({ error: '今日はすでに出勤打刻済みです' }, 409);
  return c.json({ success: true, record });
});

attendance.post('/clock-out', async (c) => {
  const user = c.get('user');
  const body: Record<string, unknown> = c.req.raw.body === null
    ? {}
    : await readJsonObject(c.req.raw);
  assertOnlyKeys(body, ['clock_out', 'break_minutes']);
  const now = new Date();
  const clockOut = nullableTime(body.clock_out, '退勤時刻') ?? nowTimeJST(now);
  const date = todayJST(now);
  const currentTime = nowTimeJST(now);

  const openRecord = await findRecentOpenAttendance(c.env.DB, user.id, date);
  if (!openRecord) {
    return c.json({ error: '先に出勤打刻をしてください' }, 400);
  }
  if (isStaleRecentAttendance(openRecord, date, currentTime)) {
    return c.json({ error: openAttendanceConflictMessage(openRecord, true) }, 409);
  }

  let breakMinutes = openRecord.break_minutes;
  if (body.break_minutes !== undefined) {
    breakMinutes = boundedInteger(body.break_minutes, '休憩（分）', 0, 480);
  }

  if (openRecord.work_date === date) {
    if (openRecord.clock_in && timeToMinutes(clockOut) < timeToMinutes(openRecord.clock_in)) {
      throw new RequestValidationError('退勤時刻が出勤時刻より前です。時刻を確認してください');
    }
  } else if (openRecord.work_date === previousDate(date)) {
    if (
      openRecord.clock_in
      && timeToMinutes(clockOut) >= timeToMinutes(openRecord.clock_in)
    ) {
      return c.json({ error: '前日の出勤から24時間を経過しています。打刻修正画面から修正してください' }, 409);
    }
  } else {
    return c.json({ error: `${openRecord.work_date} の未退勤記録が残っています。打刻修正画面から修正してください` }, 409);
  }

  if (openRecord.clock_in) {
    const span = shiftSpanMinutes(openRecord.clock_in, clockOut);
    if (span > MAX_SHIFT_MINUTES) {
      throw new RequestValidationError('勤務時間が18時間を超えています。時刻を確認してください');
    }
    if (breakMinutes > span) {
      throw new RequestValidationError('休憩時間は勤務時間を超えて指定できません');
    }
  }

  const record = await c.env.DB.prepare(
    `UPDATE attendance
     SET clock_out = ?, break_minutes = ?, updated_at = datetime('now')
     WHERE user_id = ? AND work_date = ?
       AND clock_in IS NOT NULL AND clock_out IS NULL
       AND work_type IN ('office', 'remote')
     RETURNING *`,
  )
    .bind(clockOut, breakMinutes, user.id, openRecord.work_date)
    .first<Attendance>();

  if (!record) return c.json({ error: '退勤記録が更新されました。画面を再読み込みしてください' }, 409);
  return c.json({ success: true, record });
});

attendance.get('/:year/:month', async (c) => {
  const { year, month } = yearMonthValues(c.req.param('year'), c.req.param('month'));
  return c.json(await buildMonthlySummary(c.env, c.get('user'), year, month));
});

attendance.put('/:date', async (c) => {
  const user = c.get('user');
  const date = dateValue(c.req.param('date'));
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, [
    'work_type',
    'clock_in',
    'clock_out',
    'break_minutes',
    'transport_trip_type',
    'transport_mode',
    'transport_origin',
    'transport_destination',
    'transport_one_way_fee',
    'memo',
  ]);
  const existing = await c.env.DB.prepare(
    'SELECT * FROM attendance WHERE user_id = ? AND work_date = ?',
  )
    .bind(user.id, date)
    .first<Attendance>();

  const attendanceDefaults = getUserAttendanceDefaults(c.env, user);
  const defaults = getUserCommuteDefaults(c.env, user);
  const workType = workTypeValue(body.work_type, existing?.work_type ?? attendanceDefaults.work_type);
  let clockIn = nullableTime(body.clock_in, '出勤時刻');
  let clockOut = nullableTime(body.clock_out, '退勤時刻');
  let breakMinutes = boundedInteger(
    body.break_minutes,
    '休憩（分）',
    0,
    480,
    existing?.break_minutes ?? attendanceDefaults.break_minutes,
  );
  const memo = optionalString(body.memo, '備考', 500) ?? existing?.memo ?? '';
  const preserveExistingCommute = existing?.work_type === 'office';
  let tripType = tripTypeValue(
    body.transport_trip_type,
    preserveExistingCommute ? existing.transport_trip_type : defaults.trip_type,
  );
  let transportMode = transportModeValue(
    body.transport_mode,
    preserveExistingCommute ? existing.transport_mode : defaults.transport_mode,
  );
  const requestedOrigin = optionalString(body.transport_origin, '出発地', 120);
  const requestedDestination = optionalString(body.transport_destination, '到着地', 120);
  let transportOrigin = requestedOrigin
    ?? (preserveExistingCommute ? existing.transport_origin : defaults.transport_origin);
  let transportDestination = requestedDestination
    ?? (preserveExistingCommute ? existing.transport_destination : defaults.transport_destination);
  const requestedFare = nullableBoundedInteger(
    body.transport_one_way_fee,
    '片道交通費',
    0,
    100_000,
  );
  let oneWayFare = resolveOneWayFare(
    requestedFare,
    preserveExistingCommute
      ? existing.transport_one_way_fee ?? defaults.one_way_fare
      : defaults.one_way_fare,
  );

  if (isClockable(workType)) {
    if (clockIn === undefined) clockIn = existing?.clock_in ?? null;
    if (clockOut === undefined) clockOut = existing?.clock_out ?? null;
    if (!clockIn && clockOut) throw new RequestValidationError('退勤時刻を入力する前に出勤時刻を入力してください');

    const now = new Date();
    const today = todayJST(now);
    // A future date can only hold a plan, never worked time. Without this an
    // off-by-one year silently adds work minutes to a month nobody reviews yet.
    if ((clockIn || clockOut) && date > today) {
      throw new RequestValidationError('未来の日付に出退勤時刻は記録できません');
    }

    if (clockIn && clockOut) {
      const span = shiftSpanMinutes(clockIn, clockOut);
      if (span > MAX_SHIFT_MINUTES) {
        throw new RequestValidationError('勤務時間が18時間を超えています。時刻を確認してください');
      }
      if (breakMinutes > span) {
        throw new RequestValidationError('休憩時間は勤務時間を超えて指定できません');
      }
    } else if (clockIn && !clockOut) {
      const currentTime = nowTimeJST(now);
      const yesterday = previousDate(today);
      // Mutual exclusion only applies within the active window (today / yesterday)
      if (date === today || date === yesterday) {
        const otherActive = await c.env.DB.prepare(
          `SELECT work_date, clock_in
           FROM attendance
           WHERE user_id = ?
             AND work_date != ?
             AND work_date IN (?, ?)
             AND clock_in IS NOT NULL
             AND clock_out IS NULL
             AND work_type IN ('office', 'remote')
           LIMIT 1`,
        )
          .bind(user.id, date, today, yesterday)
          .first<Pick<Attendance, 'work_date' | 'clock_in'>>();

        if (otherActive) {
          return c.json({
            error: openAttendanceConflictMessage(
              otherActive,
              isStaleRecentAttendance(otherActive, today, currentTime),
            ),
          }, 409);
        }
      }
    }
  } else {
    clockIn = null;
    clockOut = null;
    breakMinutes = 0;
    oneWayFare = 0;
    tripType = 'one_way';
    transportMode = 'rail';
    transportOrigin = '';
    transportDestination = '';
  }

  if (workType !== 'office') {
    oneWayFare = 0;
    tripType = 'one_way';
    transportMode = 'rail';
    transportOrigin = '';
    transportDestination = '';
  }
  const totalFare = workType === 'office' ? fareTotal(oneWayFare, tripType) : 0;

  const upsert = c.env.DB.prepare(
    `INSERT INTO attendance (
       user_id, work_date, work_type, clock_in, clock_out, break_minutes,
       transport_fee, transport_one_way_fee, transport_trip_type,
       transport_mode, transport_origin, transport_destination, memo
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, work_date) DO UPDATE SET
       work_type = excluded.work_type,
       clock_in = excluded.clock_in,
       clock_out = excluded.clock_out,
       break_minutes = excluded.break_minutes,
       transport_fee = excluded.transport_fee,
       transport_one_way_fee = excluded.transport_one_way_fee,
       transport_trip_type = excluded.transport_trip_type,
       transport_mode = excluded.transport_mode,
       transport_origin = excluded.transport_origin,
       transport_destination = excluded.transport_destination,
       memo = excluded.memo,
       updated_at = datetime('now')
     RETURNING *`,
  ).bind(
    user.id,
    date,
    workType,
    clockIn,
    clockOut,
    breakMinutes,
    totalFare,
    oneWayFare,
    tripType,
    transportMode,
    transportOrigin,
    transportDestination,
    memo,
  );
  const record = await upsert.first<Attendance>();
  return c.json({ success: true, record });
});

attendance.delete('/:date', async (c) => {
  const user = c.get('user');
  const date = dateValue(c.req.param('date'));
  const existing = await c.env.DB.prepare(
    'DELETE FROM attendance WHERE user_id = ? AND work_date = ? RETURNING *',
  )
    .bind(user.id, date)
    .first<Attendance>();
  if (!existing) return c.json({ error: 'この日に削除できる記録はありません' }, 404);
  return c.json({ success: true });
});

export default attendance;
