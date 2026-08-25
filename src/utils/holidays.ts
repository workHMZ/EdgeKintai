import type { Holiday, HolidayData } from '../types';

const OFFICIAL_CSV_URL =
  'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const OFFICIAL_DATE_HEADER = '国民の祝日・休日月日';
const OFFICIAL_NAME_HEADER = '国民の祝日・休日名称';
const OFFICIAL_SOURCE = 'official-csv';

// The scheduled refresh runs weekly. Allow one extra day before reporting that
// an otherwise valid cache is stale, so a short source outage is visible to the
// caller without discarding the last known-good official data.
const CACHE_FRESH_MS = 8 * 24 * 60 * 60 * 1000;
const MIN_HOLIDAYS_PER_YEAR = 16;
const MAX_HOLIDAYS_PER_YEAR = 25;
const MAX_SYNC_YEARS = 10;
const MAX_CSV_BYTES = 1_000_000;
const FAILED_SYNC_RETRY_MINUTES = 15;

// Standing Holiday Act rules alone cannot reproduce 2016-2021: Emperor's
// Birthday moved from 12/23 to 2/23 (in force from 2020, with no such holiday
// in 2019), the 2019 imperial succession added 4/30, 5/1, 5/2 and 10/22, and
// the Olympic Acts moved Marine Day, Mountain Day and Sports Day in both 2020
// and 2021. The vernal/autumnal equinox approximations are only published for
// 1980-2099. Anything outside this window must come from the official CSV.
const RULE_BASED_MIN_YEAR = 2022;
const RULE_BASED_MAX_YEAR = 2099;

export class HolidayDataUnavailableError extends Error {
  readonly year: number;

  constructor(year: number) {
    super(`Authoritative Japanese holiday data is unavailable for ${year}`);
    this.name = 'HolidayDataUnavailableError';
    this.year = year;
  }
}

export interface HolidaySyncOptions {
  /** Re-throw source failures so scheduled executions are marked failed. */
  throwOnFailure?: boolean;
  /** Years that must be present in an otherwise valid official CSV. */
  requiredYears?: readonly number[];
}

type HolidayCacheRow = Holiday & {
  row_source: string;
  state_source: string | null;
  item_count: number | null;
  synced_at: string | null;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function formatUtcDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function generateRuleBasedHolidays(year: number): Holiday[] {
  // 1980-2099 eq calculation formulas
  const getAutumnal = (y: number) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  const getVernal = (y: number) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  const getNthDay = (y: number, m: number, nth: number, dow: number) => {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + (dow - first + 7) % 7 + (nth - 1) * 7;
  };
  const fmt = (m: number, d: number) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const bases: { d: string; n: string }[] = [
    { d: fmt(1, 1), n: '元日' },
    { d: fmt(1, getNthDay(year, 1, 2, 1)), n: '成人の日' },
    { d: fmt(2, 11), n: '建国記念の日' },
    { d: fmt(2, 23), n: '天皇誕生日' },
    { d: fmt(3, getVernal(year)), n: '春分の日' },
    { d: fmt(4, 29), n: '昭和の日' },
    { d: fmt(5, 3), n: '憲法記念日' },
    { d: fmt(5, 4), n: 'みどりの日' },
    { d: fmt(5, 5), n: 'こどもの日' },
    { d: fmt(7, getNthDay(year, 7, 3, 1)), n: '海の日' },
    { d: fmt(8, 11), n: '山の日' },
    { d: fmt(9, getNthDay(year, 9, 3, 1)), n: '敬老の日' },
    { d: fmt(9, getAutumnal(year)), n: '秋分の日' },
    { d: fmt(10, getNthDay(year, 10, 2, 1)), n: 'スポーツの日' },
    { d: fmt(11, 3), n: '文化の日' },
    { d: fmt(11, 23), n: '勤労感謝の日' }
  ].sort((a, b) => a.d.localeCompare(b.d));

  const holidaySet = new Set(bases.map((holiday) => holiday.d));

  // Citizens' Holiday (国民の休日)
  const citizenHolidays: { d: string; n: string }[] = [];
  for (let i = 0; i < bases.length - 1; i++) {
    const t1 = new Date(`${bases[i].d}T00:00:00Z`).getTime();
    const t2 = new Date(`${bases[i + 1].d}T00:00:00Z`).getTime();

    if (t2 - t1 === 2 * ONE_DAY_MS) {
      const mid = new Date(t1 + ONE_DAY_MS);
      if (mid.getUTCDay() !== 0) {
        const midStr = formatUtcDate(mid);
        if (!holidaySet.has(midStr)) {
          holidaySet.add(midStr);
          citizenHolidays.push({ d: midStr, n: '休日' });
        }
      }
    }
  }

  bases.push(...citizenHolidays);
  bases.sort((a, b) => a.d.localeCompare(b.d));

  // Substitute Holiday (振替休日)
  const finalHolidays = [...bases];
  for (const h of bases) {
    const d = new Date(`${h.d}T00:00:00Z`);
    if (d.getUTCDay() === 0) {
      const sub = new Date(d.getTime());
      while (true) {
        sub.setUTCDate(sub.getUTCDate() + 1);
        const subStr = formatUtcDate(sub);
        if (!holidaySet.has(subStr)) {
          holidaySet.add(subStr);
          finalHolidays.push({ d: subStr, n: '休日' });
          break;
        }
      }
    }
  }

  finalHolidays.sort((a, b) => a.d.localeCompare(b.d));
  return finalHolidays.map(h => ({ date_str: h.d, name_ja: h.n }));
}

function cloneHolidays(holidays: readonly Holiday[]): Holiday[] {
  return holidays.map((holiday) => ({ ...holiday }));
}

function isValidYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1955 && year <= 2100;
}

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() + 1 !== month
    || candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function officialDateToIso(value: string): string | null {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return parseIsoDate(iso) ? iso : null;
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('Official holiday CSV contains an unterminated quoted field');
  fields.push(field);
  return fields;
}

/** Parse and strictly validate the Cabinet Office CP932 CSV after decoding. */
export function parseOfficialHolidayCsv(csv: string): Map<number, Holiday[]> {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) throw new Error('Official holiday CSV is empty');

  const header = parseCsvRow(lines[0]).map((value) => value.trim());
  if (
    header.length !== 2
    || header[0] !== OFFICIAL_DATE_HEADER
    || header[1] !== OFFICIAL_NAME_HEADER
  ) {
    throw new Error('Official holiday CSV header does not match the Cabinet Office format');
  }

  // The requested years receive a stricter per-year check below. This broad
  // bound catches empty/error bodies without depending on how much history the
  // Cabinet Office chooses to retain in future versions of the file.
  const itemCount = lines.length - 1;
  if (itemCount < MIN_HOLIDAYS_PER_YEAR || itemCount > 5_000) {
    throw new Error(`Official holiday CSV row count is implausible: ${itemCount}`);
  }

  const byYear = new Map<number, Holiday[]>();
  const seenDates = new Set<string>();

  for (let lineNumber = 1; lineNumber < lines.length; lineNumber += 1) {
    const fields = parseCsvRow(lines[lineNumber]);
    if (fields.length !== 2) {
      throw new Error(`Official holiday CSV row ${lineNumber + 1} has ${fields.length} columns`);
    }

    const dateStr = officialDateToIso(fields[0]);
    const nameJa = fields[1].trim();
    if (!dateStr) throw new Error(`Official holiday CSV row ${lineNumber + 1} has an invalid date`);
    if (!nameJa || nameJa.length > 100) {
      throw new Error(`Official holiday CSV row ${lineNumber + 1} has an invalid name`);
    }
    if (seenDates.has(dateStr)) {
      throw new Error(`Official holiday CSV contains duplicate date ${dateStr}`);
    }
    seenDates.add(dateStr);

    const year = Number(dateStr.slice(0, 4));
    const holidays = byYear.get(year) ?? [];
    holidays.push({ date_str: dateStr, name_ja: nameJa });
    byYear.set(year, holidays);
  }

  for (const holidays of byYear.values()) {
    holidays.sort((left, right) => left.date_str.localeCompare(right.date_str));
  }
  return byYear;
}

function validateOfficialYear(year: number, holidays: readonly Holiday[]): void {
  if (
    holidays.length < MIN_HOLIDAYS_PER_YEAR
    || holidays.length > MAX_HOLIDAYS_PER_YEAR
  ) {
    throw new Error(`Official holiday count for ${year} is implausible: ${holidays.length}`);
  }

  const seen = new Set<string>();
  for (const holiday of holidays) {
    const parsed = parseIsoDate(holiday.date_str);
    if (!parsed || parsed.year !== year || !holiday.name_ja.trim()) {
      throw new Error(`Official holiday data for ${year} contains an invalid item`);
    }
    if (seen.has(holiday.date_str)) {
      throw new Error(`Official holiday data for ${year} contains duplicate ${holiday.date_str}`);
    }
    seen.add(holiday.date_str);
  }
}

function parseDatabaseTimestamp(value: string | null): number | null {
  if (!value) return null;
  // SQLite datetime('now') has no timezone suffix but is UTC.
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function unavailableHolidayData(year: number): HolidayData {
  return {
    year,
    holidays: [],
    source: 'unavailable',
    complete: false,
    synced_at: null,
  };
}

/**
 * The generator below only encodes the *standing* Holiday Act rules. Outside
 * RULE_BASED_MIN_YEAR..RULE_BASED_MAX_YEAR it would silently produce a wrong
 * calendar, so those years are reported as unavailable and are resolved from
 * the Cabinet Office CSV by `getRequiredHolidayData` instead.
 */
function ruleBasedHolidayData(year: number): HolidayData | null {
  if (year < RULE_BASED_MIN_YEAR || year > RULE_BASED_MAX_YEAR) return null;
  const fallback = generateRuleBasedHolidays(year);
  return {
    year,
    holidays: cloneHolidays(fallback),
    source: 'rule-based',
    complete: false,
    synced_at: null,
  };
}

async function readResponseBytesLimited(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      throw new Error('Cabinet Office holiday CSV exceeds the 1 MB safety limit');
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new Error('Cabinet Office holiday CSV exceeds the 1 MB safety limit');
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel('response too large');
      throw new Error('Cabinet Office holiday CSV exceeds the 1 MB safety limit');
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Read one year's last known-good official cache in a single D1 statement.
 * Legacy third-party cache rows are intentionally not considered authoritative.
 */
export async function getHolidayData(
  env: CloudflareBindings,
  year: number,
  now = new Date(),
): Promise<HolidayData> {
  if (!isValidYear(year)) return unavailableHolidayData(year);

  const cached = await env.DB.prepare(
    `SELECT
       h.date_str,
       h.name_ja,
       h.source AS row_source,
       s.source AS state_source,
       s.item_count,
       s.synced_at
     FROM holidays_cache h
     LEFT JOIN holiday_sync_state s ON s.year = h.year
     WHERE h.year = ?
     ORDER BY h.date_str`,
  )
    .bind(year)
    .all<HolidayCacheRow>();

  const rows = cached.results;
  const state = rows[0];
  const allOfficial = rows.length > 0
    && rows.every((row) => row.row_source === OFFICIAL_SOURCE)
    && state?.state_source === OFFICIAL_SOURCE
    && state.item_count === rows.length;

  if (allOfficial) {
    const holidays = rows.map(({ date_str, name_ja }) => ({ date_str, name_ja }));
    try {
      validateOfficialYear(year, holidays);
      const syncedTimestamp = parseDatabaseTimestamp(state.synced_at);
      const outdated = syncedTimestamp === null
        || now.getTime() - syncedTimestamp > CACHE_FRESH_MS
        || now.getTime() < syncedTimestamp;
      // Only the current and future years are refreshed by the weekly job. A
      // year that has already ended cannot gain or lose holidays, so age alone
      // must not mark its cache incomplete for the rest of time.
      const stale = syncedTimestamp === null
        || (outdated && year >= currentAndNextJstYears(now)[0]);
      return {
        year,
        holidays,
        source: 'cache',
        complete: !stale,
        synced_at: state.synced_at,
      };
    } catch {
      // Do not expose a malformed cache. The explicitly incomplete rule-based
      // fallback below remains available as a last resort.
    }
  }

  return ruleBasedHolidayData(year) ?? unavailableHolidayData(year);
}

/**
 * Fetch the Cabinet Office CSV once, then atomically replace each requested
 * year's cache. Normal current+next-year refresh uses only six D1 statements.
 * Any fetch, parse, validation, or batch failure leaves the old cache intact.
 */
export async function syncOfficialHolidays(
  env: CloudflareBindings,
  years: readonly number[],
  options: HolidaySyncOptions = {},
): Promise<HolidayData[]> {
  const requestedYears = [...new Set(years)];
  if (
    requestedYears.length === 0
    || requestedYears.length > MAX_SYNC_YEARS
    || requestedYears.some((year) => !isValidYear(year))
  ) {
    throw new RangeError(`Holiday sync requires 1-${MAX_SYNC_YEARS} valid years`);
  }
  if (options.requiredYears?.some((year) => !requestedYears.includes(year))) {
    throw new RangeError('Required holiday years must be included in requested years');
  }

  try {
    const response = await fetch(OFFICIAL_CSV_URL, {
      headers: { Accept: 'text/csv' },
      cache: 'no-cache',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Cabinet Office holiday CSV returned HTTP ${response.status}`);
    }

    const csvBytes = await readResponseBytesLimited(response, MAX_CSV_BYTES);
    const csv = new TextDecoder('shift_jis', { fatal: true, ignoreBOM: false }).decode(csvBytes);
    const officialByYear = parseOfficialHolidayCsv(csv);
    for (const requiredYear of options.requiredYears ?? []) {
      if (!officialByYear.has(requiredYear)) {
        throw new Error(`Official holiday CSV does not contain required year ${requiredYear}`);
      }
    }
    const sourceModified = response.headers.get('last-modified')
      ?? response.headers.get('etag');

    const statements: D1PreparedStatement[] = [];
    const refreshed = new Map<number, Holiday[]>();

    for (const year of requestedYears) {
      const holidays = officialByYear.get(year);
      // The Cabinet Office normally publishes only through the following year.
      // A not-yet-published year is not a reason to destroy its previous cache.
      if (!holidays) continue;
      validateOfficialYear(year, holidays);

      statements.push(
        env.DB.prepare('DELETE FROM holidays_cache WHERE year = ?').bind(year),
      );

      // Four bound values per item and at most 25 items keeps this statement at
      // D1's 100-bound-parameter limit.
      const valueGroups = holidays.map(() => '(?, ?, ?, ?)').join(', ');
      const values = holidays.flatMap((holiday) => [
        year,
        holiday.date_str,
        holiday.name_ja,
        OFFICIAL_SOURCE,
      ]);
      statements.push(
        env.DB.prepare(
          `INSERT INTO holidays_cache (year, date_str, name_ja, source)
           VALUES ${valueGroups}`,
        ).bind(...values),
      );
      statements.push(
        env.DB.prepare(
          `INSERT INTO holiday_sync_state
             (year, source, item_count, source_modified, synced_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(year) DO UPDATE SET
             source = excluded.source,
             item_count = excluded.item_count,
             source_modified = excluded.source_modified,
             synced_at = excluded.synced_at`,
        ).bind(year, OFFICIAL_SOURCE, holidays.length, sourceModified),
      );
      statements.push(
        env.DB.prepare('DELETE FROM holiday_sync_failures WHERE year = ?').bind(year),
      );
      refreshed.set(year, holidays);
    }

    if (statements.length > 0) await env.DB.batch(statements);

    const syncedAt = new Date().toISOString();
    const results: HolidayData[] = [];
    for (const year of requestedYears) {
      const holidays = refreshed.get(year);
      if (holidays) {
        results.push({
          year,
          holidays: cloneHolidays(holidays),
          source: 'official-csv',
          complete: true,
          synced_at: syncedAt,
        });
      } else {
        results.push(await getHolidayData(env, year));
      }
    }
    return results;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'holiday_sync_failed',
      error: error instanceof Error ? error.name : 'UnknownError',
    }));
    if (options.throwOnFailure) throw error;
    return Promise.all(requestedYears.map((year) => getHolidayData(env, year)));
  }
}

/**
 * Return data safe for monthly calculations. An authoritative cache is used as
 * is, and a year the standing rules reproduce exactly is served from those
 * rules without a network call. Only a year that can be neither cached nor
 * derived is fetched on demand, throttled by `holiday_sync_failures`. If the
 * official source is unavailable too we fail closed instead of counting
 * national holidays as ordinary workdays.
 */
export async function getRequiredHolidayData(
  env: CloudflareBindings,
  year: number,
): Promise<HolidayData> {
  const cached = await getHolidayData(env, year);
  if (cached.source !== 'unavailable') return cached;

  const recentFailure = await env.DB.prepare(
    `SELECT year
     FROM holiday_sync_failures
     WHERE year = ? AND retry_after > datetime('now')
     LIMIT 1`,
  )
    .bind(year)
    .first<{ year: number }>();
  if (recentFailure) throw new HolidayDataUnavailableError(year);

  const [synced] = await syncOfficialHolidays(env, [year]);
  if (synced?.source !== 'unavailable') return synced;
  await env.DB.prepare(
    `INSERT INTO holiday_sync_failures (year, retry_after, created_at)
     VALUES (?, datetime('now', ?), datetime('now'))
     ON CONFLICT(year) DO UPDATE SET
       retry_after = excluded.retry_after,
       created_at = excluded.created_at`,
  )
    .bind(year, `+${FAILED_SYNC_RETRY_MINUTES} minutes`)
    .run();
  throw new HolidayDataUnavailableError(year);
}

/** Current JST year plus next year, intended for the weekly scheduled handler. */
export function currentAndNextJstYears(now = new Date()): [number, number] {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentYear = jst.getUTCFullYear();
  return [currentYear, currentYear + 1];
}

export async function syncCurrentAndNextOfficialHolidays(
  env: CloudflareBindings,
  now = new Date(),
  options: HolidaySyncOptions = {},
): Promise<HolidayData[]> {
  const years = currentAndNextJstYears(now);
  const requiredYears = options.throwOnFailure
    ? [...new Set([years[0], ...(options.requiredYears ?? [])])]
    : options.requiredYears;
  return syncOfficialHolidays(env, years, { ...options, requiredYears });
}

/** Build a de-duplicated date-to-name map. */
export function buildHolidayMap(holidays: readonly Holiday[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const holiday of holidays) map.set(holiday.date_str, holiday.name_ja);
  return map;
}
