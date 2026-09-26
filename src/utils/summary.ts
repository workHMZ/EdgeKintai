import type {
  Attendance,
  AttendanceWithDay,
  HolidayData,
  MonthlySummary,
  PublicAppConfig,
  User,
} from '../types';
import { getPublicConfig, getUserCommuteDefaults } from './config';
import { getRequiredHolidayData, buildHolidayMap } from './holidays';
import {
  calcWorkMinutes,
  dayOfWeek,
  daysInMonth,
  isValidDate,
  monthStart,
  nextMonthStart,
  todayJST,
} from './time';

type SummaryUser = Pick<
  User,
  | 'id'
  | 'username'
  | 'display_name'
  | 'default_one_way_fare'
  | 'default_trip_type'
  | 'default_transport_mode'
  | 'default_transport_origin'
  | 'default_transport_destination'
>;

export interface MonthlySummaryBuildOptions {
  /** Controls which missing scheduled days count as incomplete. Defaults to today in JST. */
  as_of_date?: string;
  cachedConfig?: PublicAppConfig;
}

function assertValidMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 1955 || year > 2100) {
    throw new RangeError('Summary year is invalid');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('Summary month is invalid');
  }
}

function isWorkingType(record: Attendance): boolean {
  return record.work_type === 'office' || record.work_type === 'remote';
}

function placeholderAttendance(
  userId: number,
  dateStr: string,
  nonScheduledDay: boolean,
  defaultTripType: Attendance['transport_trip_type'],
): Attendance {
  return {
    id: 0,
    user_id: userId,
    work_date: dateStr,
    work_type: nonScheduledDay ? 'holiday' : 'absent',
    clock_in: null,
    clock_out: null,
    break_minutes: 0,
    transport_fee: 0,
    transport_one_way_fee: null,
    transport_trip_type: defaultTripType,
    transport_mode: 'rail',
    transport_origin: '',
    transport_destination: '',
    memo: '',
    created_at: '',
    updated_at: '',
    revision: 0,
  };
}

/**
 * Pure aggregation layer for callers (such as the admin overview) that already
 * fetched attendance rows in one set-based query. It performs no D1 or network
 * I/O. Pass `as_of_date` in tests or historical reports for deterministic
 * incomplete-day calculation.
 */
export function buildMonthlySummaryFromRecords(
  env: CloudflareBindings,
  user: SummaryUser,
  year: number,
  month: number,
  records: readonly Attendance[],
  holidayData: HolidayData,
  options: MonthlySummaryBuildOptions = {},
): MonthlySummary {
  assertValidMonth(year, month);
  if (holidayData.year !== year) {
    throw new RangeError('Holiday data year does not match summary year');
  }

  const config = options.cachedConfig ?? getPublicConfig(env);
  const commuteDefaults = getUserCommuteDefaults(env, user, config);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}-`;
  const recordMap = new Map<string, Attendance>();
  for (const record of records) {
    if (record.user_id !== user.id || !record.work_date.startsWith(monthPrefix)) continue;
    if (recordMap.has(record.work_date)) {
      throw new Error(`Duplicate attendance record for ${record.work_date}`);
    }
    recordMap.set(record.work_date, record);
  }

  const holidayMap = buildHolidayMap(holidayData.holidays);
  const asOfDate = options.as_of_date ?? todayJST();
  if (!isValidDate(asOfDate)) throw new RangeError('Summary as_of_date is invalid');
  const resultRecords: AttendanceWithDay[] = [];

  let officeDays = 0;
  let remoteDays = 0;
  let paidLeaveDays = 0;
  let absentDays = 0;
  let scheduledWorkDays = 0;
  let incompleteDays = 0;
  let totalWorkMinutes = 0;
  let totalTransportFee = 0;

  for (let day = 1; day <= daysInMonth(year, month); day += 1) {
    const dateStr = `${monthPrefix}${String(day).padStart(2, '0')}`;
    const weekday = dayOfWeek(dateStr);
    const holidayName = holidayMap.get(dateStr) ?? null;
    const isHoliday = holidayName !== null;
    const isWeekend = weekday === 0 || weekday === 6;
    const isScheduled = !isWeekend && !isHoliday;
    if (isScheduled) scheduledWorkDays += 1;

    const record = recordMap.get(dateStr);
    let workMinutes: number | null = null;

    if (record) {
      // Fare is the recorded total and is independent of complete clock punches.
      totalTransportFee += record.transport_fee;

      if (record.work_type === 'office') officeDays += 1;
      else if (record.work_type === 'remote') remoteDays += 1;
      else if (record.work_type === 'paid_leave') paidLeaveDays += 1;
      else if (record.work_type === 'absent') absentDays += 1;

      if (isWorkingType(record)) {
        if (record.clock_in && record.clock_out) {
          // calcWorkMinutes also handles an overnight shift such as 22:00-06:00.
          workMinutes = calcWorkMinutes(
            record.clock_in,
            record.clock_out,
            record.break_minutes,
          );
          totalWorkMinutes += workMinutes;
        } else if (dateStr < asOfDate) {
          incompleteDays += 1;
        }
      }
      // paid_leave, holiday and absent are complete classifications without
      // requiring clock punches and never contribute worked minutes.
    } else if (isScheduled && dateStr < asOfDate) {
      incompleteDays += 1;
    }

    const base = record
      ?? placeholderAttendance(
        user.id,
        dateStr,
        !isScheduled,
        commuteDefaults.trip_type,
      );
    resultRecords.push({
      ...base,
      day_of_week: weekday,
      is_holiday: isHoliday,
      holiday_name: holidayName,
      work_minutes: workMinutes,
    });
  }

  // This is a company-configured monthly reporting threshold. It is not a
  // determination of statutory overtime under Japanese labour law.
  const overtimeThresholdMinutes = config.overtime_threshold_hours * 60;
  const overtimeMinutes = Math.max(0, totalWorkMinutes - overtimeThresholdMinutes);
  const { holidays: _holidays, ...holidayMetadata } = holidayData;

  return {
    year,
    month,
    username: user.username,
    employee_name: user.display_name || user.username,
    office_days: officeDays,
    remote_days: remoteDays,
    paid_leave_days: paidLeaveDays,
    absent_days: absentDays,
    scheduled_work_days: scheduledWorkDays,
    incomplete_days: incompleteDays,
    total_work_minutes: totalWorkMinutes,
    total_transport_fee: totalTransportFee,
    overtime_minutes: overtimeMinutes,
    overtime_threshold_minutes: overtimeThresholdMinutes,
    default_one_way_fare: commuteDefaults.one_way_fare,
    default_trip_type: commuteDefaults.trip_type,
    default_transport_mode: commuteDefaults.transport_mode,
    default_transport_origin: commuteDefaults.transport_origin,
    default_transport_destination: commuteDefaults.transport_destination,
    records: resultRecords,
    holiday_data: holidayMetadata,
  };
}

/**
 * Shared route-facing builder: one attendance statement and, unless holiday
 * data was supplied by the caller, one holiday-cache statement.
 */
export async function buildMonthlySummary(
  env: CloudflareBindings,
  user: SummaryUser,
  year: number,
  month: number,
  optionalHolidayData?: HolidayData,
): Promise<MonthlySummary> {
  assertValidMonth(year, month);
  if (optionalHolidayData && optionalHolidayData.year !== year) {
    throw new RangeError('Holiday data year does not match summary year');
  }

  const [attendanceResult, holidayData] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM attendance
       WHERE user_id = ? AND work_date >= ? AND work_date < ?
       ORDER BY work_date`,
    )
      .bind(user.id, monthStart(year, month), nextMonthStart(year, month))
      .all<Attendance>(),
    optionalHolidayData
      ? Promise.resolve(optionalHolidayData)
      : getRequiredHolidayData(env, year),
  ]);

  return buildMonthlySummaryFromRecords(
    env,
    user,
    year,
    month,
    attendanceResult.results,
    holidayData,
  );
}
