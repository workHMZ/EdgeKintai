import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Attendance } from '../src/types';
import { getHolidayData } from '../src/utils/holidays';
import { buildMonthlySummaryFromRecords } from '../src/utils/summary';

const testUser = {
  id: 1,
  username: 'testuser',
  display_name: 'テスト 太郎',
  default_one_way_fare: 220,
  default_trip_type: 'round_trip' as const,
  default_transport_mode: 'rail' as const,
  default_transport_origin: '新宿駅',
  default_transport_destination: '東京駅',
};

function createAttendanceRecord(partial: Partial<Attendance> & { work_date: string }): Attendance {
  return {
    id: 1,
    revision: partial.revision ?? 1,
    user_id: 1,
    work_date: partial.work_date,
    work_type: partial.work_type ?? 'office',
    clock_in: partial.clock_in ?? null,
    clock_out: partial.clock_out ?? null,
    break_minutes: partial.break_minutes ?? 60,
    transport_fee: partial.transport_fee ?? 440,
    transport_one_way_fee: partial.transport_one_way_fee ?? 220,
    transport_trip_type: partial.transport_trip_type ?? 'round_trip',
    transport_mode: partial.transport_mode ?? 'rail',
    transport_origin: partial.transport_origin ?? '新宿駅',
    transport_destination: partial.transport_destination ?? '東京駅',
    memo: partial.memo ?? '',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  };
}

describe('Monthly Summary calculation rules', () => {
  it('does not count today as incomplete when there is no record or an active shift', async () => {
    const holidayData = await getHolidayData(env, 2026);

    // 2026-07-01 is Wednesday (yesterday, completed)
    // 2026-07-02 is Thursday (today, active shift: clock_in but no clock_out)
    const records = [
      createAttendanceRecord({
        work_date: '2026-07-01',
        work_type: 'office',
        clock_in: '09:00',
        clock_out: '18:00',
        break_minutes: 60,
      }),
      createAttendanceRecord({
        work_date: '2026-07-02',
        work_type: 'office',
        clock_in: '09:00',
        clock_out: null,
        break_minutes: 60,
      }),
    ];

    const summary = buildMonthlySummaryFromRecords(
      env,
      testUser,
      2026,
      7,
      records,
      holidayData,
      { as_of_date: '2026-07-02' },
    );

    // 2026-07-01 is complete; 2026-07-02 is today active shift -> incomplete_days must be 0
    expect(summary.incomplete_days).toBe(0);
    expect(summary.total_work_minutes).toBe(480);
  });

  it('counts yesterday as incomplete when missing record or open shift', async () => {
    const holidayData = await getHolidayData(env, 2026);

    // Case A: 2026-07-01 (yesterday) has no record, 2026-07-02 (today) has no record
    const summaryNoRecords = buildMonthlySummaryFromRecords(
      env,
      testUser,
      2026,
      7,
      [],
      holidayData,
      { as_of_date: '2026-07-02' },
    );
    // 07-01 is missing scheduled day (< asOfDate) -> 1; 07-02 is today undecided (== asOfDate) -> 0
    expect(summaryNoRecords.incomplete_days).toBe(1);

    // Case B: 2026-07-01 (yesterday) has open shift without clock_out
    const recordsWithYesterdayOpen = [
      createAttendanceRecord({
        work_date: '2026-07-01',
        work_type: 'office',
        clock_in: '09:00',
        clock_out: null,
      }),
    ];
    const summaryYesterdayOpen = buildMonthlySummaryFromRecords(
      env,
      testUser,
      2026,
      7,
      recordsWithYesterdayOpen,
      holidayData,
      { as_of_date: '2026-07-02' },
    );
    // 07-01 is past incomplete -> 1
    expect(summaryYesterdayOpen.incomplete_days).toBe(1);
  });

  it('handles persisted working record with null clock_in and null clock_out', async () => {
    const holidayData = await getHolidayData(env, 2026);

    // Case A: Past date (2026-07-01) has persisted office with null times -> incomplete +1 (missing punch)
    const recordsPastNullTimes = [
      createAttendanceRecord({
        work_date: '2026-07-01',
        work_type: 'office',
        clock_in: null,
        clock_out: null,
      }),
    ];
    const summaryPast = buildMonthlySummaryFromRecords(
      env,
      testUser,
      2026,
      7,
      recordsPastNullTimes,
      holidayData,
      { as_of_date: '2026-07-02' },
    );
    expect(summaryPast.incomplete_days).toBe(1);

    // Case B: Today (2026-07-02) has persisted office with null times -> incomplete +0 (undecided)
    const recordsTodayNullTimes = [
      createAttendanceRecord({
        work_date: '2026-07-01',
        work_type: 'office',
        clock_in: '09:00',
        clock_out: '18:00',
      }),
      createAttendanceRecord({
        work_date: '2026-07-02',
        work_type: 'office',
        clock_in: null,
        clock_out: null,
      }),
    ];
    const summaryToday = buildMonthlySummaryFromRecords(
      env,
      testUser,
      2026,
      7,
      recordsTodayNullTimes,
      holidayData,
      { as_of_date: '2026-07-02' },
    );
    expect(summaryToday.incomplete_days).toBe(0);
  });

  it('does not count weekends and Japanese holidays as incomplete', async () => {
    const holidayData = await getHolidayData(env, 2026);

    // 2026-07-04 (Sat), 2026-07-05 (Sun), 2026-07-20 (Marine Day)
    // When as_of_date is 2026-07-06 (Monday), only workdays 07-01, 07-02, 07-03 should count if missing
    const summary = buildMonthlySummaryFromRecords(
      env,
      testUser,
      2026,
      7,
      [],
      holidayData,
      { as_of_date: '2026-07-06' },
    );

    // 07-01(Wed), 07-02(Thu), 07-03(Fri) are past missing workdays = 3
    // 07-04(Sat), 07-05(Sun) are weekend = 0
    // 07-06(Mon) is today undecided = 0
    expect(summary.incomplete_days).toBe(3);
  });
});
