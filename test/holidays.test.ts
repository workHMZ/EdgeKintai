import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildHolidayMap, getHolidayData } from '../src/utils/holidays';

async function seedOfficialCache(year: number, syncedAt: string): Promise<void> {
  const holidays = Array.from({ length: 16 }, (_, index) => ({
    date_str: `${year}-01-${String(index + 1).padStart(2, '0')}`,
    name_ja: `テスト祝日${index + 1}`,
  }));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM holidays_cache WHERE year = ?').bind(year),
    ...holidays.map((holiday) => env.DB.prepare(
      'INSERT INTO holidays_cache (year, date_str, name_ja, source) VALUES (?, ?, ?, ?)',
    ).bind(year, holiday.date_str, holiday.name_ja, 'official-csv')),
    env.DB.prepare(
      `INSERT INTO holiday_sync_state (year, source, item_count, source_modified, synced_at)
       VALUES (?, 'official-csv', ?, NULL, ?)
       ON CONFLICT(year) DO UPDATE SET
         item_count = excluded.item_count,
         synced_at = excluded.synced_at`,
    ).bind(year, holidays.length, syncedAt),
  ]);
}

describe('official Japanese holiday fallback', () => {
  it('contains the Cabinet Office 2026 substitute and statutory holidays', async () => {
    const data = await getHolidayData(env, 2026);
    const map = buildHolidayMap(data.holidays);
    expect(data).toMatchObject({ source: 'rule-based', complete: false });
    expect(data.holidays).toHaveLength(18);
    expect(map.get('2026-05-06')).toBe('休日'); // Substitute holiday for Children's Day
    expect(map.get('2026-09-22')).toBe('休日'); // Substitute holiday for Autumnal Equinox
  });

  it('correctly calculates Silver Week citizens holidays in 2032', async () => {
    // 2032 has a Citizen's Holiday (国民の休日) on 9/21
    // 9/20 is Respect for the Aged Day
    // 9/22 is Autumnal Equinox
    const data = await getHolidayData(env, 2032);
    const map = buildHolidayMap(data.holidays);
    expect(data).toMatchObject({ source: 'rule-based', complete: false });
    expect(map.get('2032-09-20')).toBe('敬老の日');
    expect(map.get('2032-09-21')).toBe('休日');
    expect(map.get('2032-09-22')).toBe('秋分の日');
  });

  it('correctly creates substitute holidays when holiday falls on Sunday', async () => {
    // 2034-01-01 should be a Sunday. So 2034-01-02 should be a substitute holiday.
    const data = await getHolidayData(env, 2034);
    const map = buildHolidayMap(data.holidays);
    expect(map.get('2034-01-01')).toBe('元日');
    expect(map.get('2034-01-02')).toBe('休日');
  });

  it('does not pretend an unpublished future year is a working calendar if < 2016', async () => {
    const data = await getHolidayData(env, 2015);
    expect(data).toMatchObject({ source: 'unavailable', complete: false, holidays: [] });
  });

  it('refuses to derive years whose calendar the standing rules cannot reproduce', async () => {
    // 2019 had no Emperor's Birthday and gained four imperial succession days;
    // 2020 and 2021 moved Marine Day, Mountain Day and Sports Day for the
    // Olympics. Deriving them would produce a confidently wrong calendar, so
    // they must fall through to the official CSV instead.
    for (const year of [2016, 2019, 2020, 2021]) {
      const data = await getHolidayData(env, year);
      expect(data).toMatchObject({ year, source: 'unavailable', complete: false, holidays: [] });
    }

    // The equinox approximations are only published through 2099.
    expect(await getHolidayData(env, 2100)).toMatchObject({ source: 'unavailable' });
  });

  it('keeps a finished year authoritative no matter how old its cache is', async () => {
    const now = new Date('2026-08-25T00:00:00Z');

    // The weekly job only refreshes the current and next year, so a past year's
    // cache is always months old. It must not be reported as incomplete.
    await seedOfficialCache(2019, '2026-01-05 03:00:00');
    expect(await getHolidayData(env, 2019, now)).toMatchObject({
      source: 'cache',
      complete: true,
    });

    // The current year does still have to be refreshed.
    await seedOfficialCache(2026, '2026-01-05 03:00:00');
    expect(await getHolidayData(env, 2026, now)).toMatchObject({
      source: 'cache',
      complete: false,
    });

    await seedOfficialCache(2026, '2026-08-24 03:00:00');
    expect(await getHolidayData(env, 2026, now)).toMatchObject({
      source: 'cache',
      complete: true,
    });
  });

  it('derives the first year the standing rules fully cover', async () => {
    const data = await getHolidayData(env, 2022);
    const map = buildHolidayMap(data.holidays);
    expect(data).toMatchObject({ source: 'rule-based', complete: false });
    expect(map.get('2022-07-18')).toBe('海の日'); // 3rd Monday, back to the standing rule
    expect(map.get('2022-08-11')).toBe('山の日');
    expect(map.get('2022-10-10')).toBe('スポーツの日'); // 2nd Monday
    expect(map.get('2022-02-23')).toBe('天皇誕生日');
  });
});
