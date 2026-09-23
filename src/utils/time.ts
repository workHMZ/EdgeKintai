const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function nowJST(now = new Date()): Date {
  return new Date(now.getTime() + JST_OFFSET_MS);
}

export function todayJST(now = new Date()): string {
  return formatDate(nowJST(now));
}

export function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatTime(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function nowTimeJST(now = new Date()): string {
  return formatTime(nowJST(now));
}

/**
 * Render a UTC instant the way SQLite's `datetime('now')` does, so explicitly
 * bound timestamps stay byte-comparable with column defaults.
 */
export function toSqliteDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Inverse of toSqliteDateTime. SQLite `datetime('now')` carries no zone suffix
 * but is UTC, whereas Date.parse would read the bare form as local time.
 */
export function parseDatabaseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export const MAX_SHIFT_MINUTES = 18 * 60;

/**
 * Calculates elapsed minutes from a dated clock-in to a dated current time.
 * Invalid persisted values are treated as infinitely old so they cannot be
 * exposed as an ordinary active shift.
 */
export function elapsedShiftMinutes(
  workDate: string,
  clockIn: string,
  currentDate: string,
  currentTime: string,
): number {
  if (
    !isValidDate(workDate)
    || !isValidTime(clockIn)
    || !isValidDate(currentDate)
    || !isValidTime(currentTime)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const [startYear, startMonth, startDay] = workDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = currentDate.split('-').map(Number);
  const startDateMinutes = Date.UTC(startYear, startMonth - 1, startDay) / 60_000;
  const endDateMinutes = Date.UTC(endYear, endMonth - 1, endDay) / 60_000;
  return endDateMinutes + timeToMinutes(currentTime)
    - startDateMinutes - timeToMinutes(clockIn);
}

/**
 * Calculates total elapsed span in minutes between clockIn and clockOut.
 * Supports a shift ending after midnight (e.g. 22:00 -> 06:00).
 */
export function shiftSpanMinutes(clockIn: string, clockOut: string): number {
  const inMinutes = timeToMinutes(clockIn);
  let outMinutes = timeToMinutes(clockOut);
  if (outMinutes < inMinutes) outMinutes += 24 * 60;
  return outMinutes - inMinutes;
}

/** Supports a shift ending after midnight, for example 22:00 -> 06:00. */
export function calcWorkMinutes(clockIn: string, clockOut: string, breakMinutes: number): number {
  const span = shiftSpanMinutes(clockIn, clockOut);
  return Math.max(0, span - breakMinutes);
}

export function dayOfWeek(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() - 1);
  return formatDate(value);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function nextMonthStart(year: number, month: number): string {
  if (month === 12) return `${year + 1}-01-01`;
  return `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

export function monthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function isValidTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

export function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1955 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() + 1 === month
    && candidate.getUTCDate() === day;
}
