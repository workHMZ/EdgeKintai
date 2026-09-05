// @ts-expect-error Vitest raw import
import appSource from '../public/app.js?raw';
import { describe, expect, it } from 'vitest';

interface TestHooks {
  attendanceState: (
    record: { persisted?: boolean; work_type?: string; clock_in?: string | null; clock_out?: string | null; day_of_week?: number; is_holiday?: boolean },
    date: string,
    today: string,
  ) => 'missing' | 'incomplete' | 'undecided' | 'active' | 'normal';
  previousDate: (value: string) => string;
  calculateWorkMinutes: (clockIn: string, clockOut: string, breakMinutes: number) => number;
  boundedInteger: (value: unknown, fallback: number, min: number, max: number) => number;
  isStalePreviousDayRecord: (
    record: { work_date: string; clock_in: string | null },
    today: string,
    currentTime: string,
  ) => boolean;
  loadToday: () => Promise<boolean>;
  handlePotentialDateRollover: () => Promise<boolean>;
  withBusy: (
    button: { disabled: boolean; innerHTML: string; textContent: string } | null | undefined,
    label: string,
    operation: () => Promise<unknown>,
  ) => Promise<unknown>;
  loadMonthData: (monthValue: string, force: boolean) => Promise<{ total_work_minutes: number }>;
  renderAdminOverview: (users: unknown[]) => void;
  formatDateTime: (value: string | Date) => string;
  renderShiftNotice: (kind: string | null, message?: string, fixDate?: string) => void;
  refreshVisibleData: (date: string) => Promise<void>;
  api: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  normalizeTimestampInput: (value: unknown) => unknown;
  getElement: (id: string) => {
    hidden: boolean;
    className: string;
    textContent: string;
    dataset: Record<string, string>;
    children: Array<{
      textContent: string;
      children: Array<{ textContent: string }>;
      classList: { contains: (name: string) => boolean };
    }>;
  };
  getLastObservedDate: () => string;
  setLastObservedDate: (val: string) => void;
  setUser: (user: unknown) => void;
  setToday: (today: unknown) => void;
  setPage: (page: string) => void;
  setApiMock: (fn: (path: string) => Promise<unknown>) => void;
}

function loadFrontendHooks(customApi?: (path: string) => Promise<unknown>): TestHooks {
  const instrumented = appSource.replace(
    'void initialize();',
    `
    if (customApi) {
      api = customApi;
    }
    return {
      attendanceState,
      previousDate,
      calculateWorkMinutes,
      boundedInteger,
      isStalePreviousDayRecord,
      loadToday,
      handlePotentialDateRollover,
      withBusy,
      loadMonthData,
      renderAdminOverview,
      formatDateTime,
      normalizeTimestampInput,
      renderShiftNotice,
      refreshVisibleData,
      api,
      getLastObservedDate: () => lastObservedDate,
      setLastObservedDate: (val) => { lastObservedDate = val; },
      setUser: (u) => { state.user = u; },
      setToday: (t) => { state.today = t; },
      setPage: (p) => { state.page = p; },
      setApiMock: (fn) => { api = fn; },
      getElement: (id) => document.getElementById(id),
    };
    `,
  );

  const createMockElement = () => {
    const children: unknown[] = [];
    const classes = new Set<string>();
    return {
      value: '',
      hidden: false,
      textContent: '',
      className: '',
      colSpan: 0,
      dataset: {} as Record<string, string>,
      children,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        toggle: () => {},
        contains: (name: string) => classes.has(name),
      },
      append: (...items: unknown[]) => children.push(...items),
      appendChild: (item: unknown) => { children.push(item); return item; },
      replaceChildren: (...items: unknown[]) => {
        children.length = 0;
        children.push(...items);
      },
      remove: () => {},
      setAttribute: () => {},
    };
  };
  const mockWindow = {
    matchMedia: () => ({ matches: false }),
    setTimeout: () => 0,
  };
  // Stable per-id elements so a test can inspect what a render function produced.
  const elements = new Map<string, ReturnType<typeof createMockElement>>();
  const mockDoc = {
    documentElement: { dataset: {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    createElement: () => createMockElement(),
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, createMockElement());
      return elements.get(id)!;
    },
  };

  const fn = new Function('window', 'document', 'navigator', 'location', 'customApi', `return ${instrumented}`);
  const hooks = fn(mockWindow, mockDoc, { clipboard: {} }, { pathname: '/' }, customApi) as TestHooks;
  if (!hooks) throw new Error('Failed to load frontend hooks from public/app.js');
  return hooks;
}

describe('Frontend Pure State Logic', () => {
  it('correctly calculates attendanceState across all date and punch conditions', () => {
    const { attendanceState } = loadFrontendHooks();
    const today = '2026-08-15';
    const pastWeekday = '2026-08-14';
    const pastWeekend = '2026-08-09';
    const futureDate = '2026-08-20';

    // 1. Past unpersisted weekday -> missing (未刻)
    expect(attendanceState({ day_of_week: 5, is_holiday: false }, pastWeekday, today)).toBe('missing');

    // 2. Past unpersisted weekend -> normal (休日)
    expect(attendanceState({ day_of_week: 0, is_holiday: false }, pastWeekend, today)).toBe('normal');

    // 3. Past unpersisted holiday -> normal (祝日)
    expect(attendanceState({ day_of_week: 2, is_holiday: true }, '2026-08-11', today)).toBe('normal');

    // 4. Past persisted office with clock_in=null -> missing (未刻)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: null,
      clock_out: null,
      day_of_week: 5,
      is_holiday: false,
    }, pastWeekday, today)).toBe('missing');

    // 5. Past persisted office ON WEEKEND with clock_in=null -> missing (未刻)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: null,
      clock_out: null,
      day_of_week: 0,
      is_holiday: false,
    }, pastWeekend, today)).toBe('missing');

    // 6. Past open shift (clock_in exists, clock_out is null) -> incomplete (未退)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: '10:00',
      clock_out: null,
      day_of_week: 5,
      is_holiday: false,
    }, pastWeekday, today)).toBe('incomplete');

    // 7. Past closed shift -> normal
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: '10:00',
      clock_out: '19:00',
      day_of_week: 5,
      is_holiday: false,
    }, pastWeekday, today)).toBe('normal');

    // 8. Past paid_leave -> normal
    expect(attendanceState({
      persisted: true,
      work_type: 'paid_leave',
      day_of_week: 5,
      is_holiday: false,
    }, pastWeekday, today)).toBe('normal');

    // 9. Today unpersisted weekday -> undecided (未定)
    expect(attendanceState({ day_of_week: 3, is_holiday: false }, today, today)).toBe('undecided');

    // 10. Today unpersisted weekend -> normal
    expect(attendanceState({ day_of_week: 6, is_holiday: false }, today, today)).toBe('normal');

    // 11. Today persisted office with clock_in=null -> undecided (未定)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: null,
      clock_out: null,
      day_of_week: 3,
      is_holiday: false,
    }, today, today)).toBe('undecided');

    // 12. Today open shift (currently working) -> active (勤務中)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: '09:30',
      clock_out: null,
      day_of_week: 3,
      is_holiday: false,
    }, today, today)).toBe('active');

    // 13. Today completed shift -> normal
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: '09:30',
      clock_out: '18:30',
      day_of_week: 3,
      is_holiday: false,
    }, today, today)).toBe('normal');

    // 14. Future date -> normal
    expect(attendanceState({ day_of_week: 4, is_holiday: false }, futureDate, today)).toBe('normal');
  });

  it('calculates previousDate accurately across month and year boundaries', () => {
    const { previousDate } = loadFrontendHooks();
    expect(previousDate('2026-08-15')).toBe('2026-08-14');
    expect(previousDate('2026-08-01')).toBe('2026-07-31');
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
    expect(previousDate('2024-03-01')).toBe('2024-02-29'); // Leap year
    expect(previousDate('2026-01-01')).toBe('2025-12-31');
    expect(previousDate('invalid')).toBe('');
  });

  it('calculates calculateWorkMinutes with overnight support', () => {
    const { calculateWorkMinutes } = loadFrontendHooks();
    expect(calculateWorkMinutes('10:00', '19:00', 60)).toBe(480);
    expect(calculateWorkMinutes('23:00', '07:00', 60)).toBe(420);
    expect(calculateWorkMinutes('10:00', '11:00', 60)).toBe(0);
  });

  it('bounds integers accurately without silent NaN corruption', () => {
    const { boundedInteger } = loadFrontendHooks();
    expect(boundedInteger('50', 0, 0, 100)).toBe(50);
    expect(boundedInteger('-5', 0, 0, 100)).toBe(0);
    expect(boundedInteger('150', 0, 0, 100)).toBe(100);
    expect(boundedInteger('abc', 42, 0, 100)).toBe(42);
  });

  it('moves a previous-day open shift to stale only after 18 hours', () => {
    const { isStalePreviousDayRecord } = loadFrontendHooks();
    const record = { work_date: '2026-08-14', clock_in: '15:00' };
    expect(isStalePreviousDayRecord(record, '2026-08-15', '09:00')).toBe(false);
    expect(isStalePreviousDayRecord(record, '2026-08-15', '09:01')).toBe(true);
    expect(isStalePreviousDayRecord(record, '2026-08-14', '23:59')).toBe(false);
  });

  it('reloads Today after repairing the previous day, not just today', async () => {
    // A stale open shift from yesterday disables both punch buttons and offers
    // the record editor as the only way out. Saving that repair has to refresh
    // Today, or the warning and the disabled buttons survive the fix and the
    // user stays locked out until a manual page reload.
    const requested: string[] = [];
    const hooks = loadFrontendHooks(async (path) => {
      requested.push(path);
      throw new Error('stop before rendering');
    });
    hooks.setUser({ id: 1 });
    hooks.setToday({ date: '2026-08-15' });
    hooks.setPage('today');

    await hooks.refreshVisibleData('2026-08-14');
    expect(requested).toEqual(['/api/attendance/today']);

    // Editing today itself keeps the behaviour it always had.
    requested.length = 0;
    await hooks.refreshVisibleData('2026-08-15');
    expect(requested).toEqual(['/api/attendance/today']);

    // Days Today cannot display must not trigger a pointless request; the
    // punch card only ever reads today and yesterday.
    requested.length = 0;
    await hooks.refreshVisibleData('2026-08-13');
    expect(requested).toEqual([]);
  });

  it('uses loadToday production failure semantics and retries a failed date rollover', async () => {
    let callCount = 0;
    const hooks = loadFrontendHooks(async (path) => {
      expect(path).toBe('/api/attendance/today');
      callCount++;
      throw new Error('Network timeout');
    });

    hooks.setUser({ id: 1, name: 'Tester' });
    hooks.setLastObservedDate('2000-01-01');

    // Real loadToday catches the network error and reports false.
    await expect(hooks.handlePotentialDateRollover()).resolves.toBe(false);
    expect(hooks.getLastObservedDate()).toBe('2000-01-01');

    // The rollback means the next lifecycle event retries the same request.
    await expect(hooks.handlePotentialDateRollover()).resolves.toBe(false);
    expect(hooks.getLastObservedDate()).toBe('2000-01-01');
    expect(callCount).toBe(2);
  });

  it('reports a dropped connection in Japanese instead of the browser default', async () => {
    const hooks = loadFrontendHooks();
    const originalFetch = globalThis.fetch;
    // Chrome throws "Failed to fetch" here and Safari throws "Load failed";
    // errorMessage() would put either straight into a toast in an otherwise
    // fully Japanese UI.
    globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    try {
      await expect(hooks.api('/api/auth/status')).rejects.toMatchObject({
        name: 'ApiError',
        status: 0,
      });
      await hooks.api('/api/auth/status').catch((error: Error) => {
        expect(error.message).toContain('ネットワーク');
        expect(error.message).not.toContain('fetch');
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('offers an inline repair action only when the punch buttons cannot help', () => {
    const hooks = loadFrontendHooks();
    const notice = hooks.getElement('today-active-shift-notice');
    const message = hooks.getElement('today-active-shift-message');
    const fix = hooks.getElement('fix-stale-record-button');

    // A stale open shift disables both 出勤 and 退勤, so the notice has to carry
    // the only way forward.
    hooks.renderShiftNotice('warning', '前日の未退勤記録があります。', '2026-08-26');
    expect(notice.hidden).toBe(false);
    expect(notice.className).toBe('notice notice-warning');
    expect(message.textContent).toBe('前日の未退勤記録があります。');
    expect(fix.hidden).toBe(false);
    expect(fix.dataset.date).toBe('2026-08-26');

    // A previous-day shift that is still active can be closed with 退勤, so the
    // notice stays purely informational.
    hooks.renderShiftNotice('info', '前日から勤務中です。');
    expect(notice.className).toBe('notice notice-info');
    expect(fix.hidden).toBe(true);
    expect(fix.dataset.date).toBe('');

    // A malformed date must not leave a button that opens nothing.
    hooks.renderShiftNotice('warning', 'x', 'not-a-date');
    expect(fix.hidden).toBe(true);
    expect(fix.dataset.date).toBe('');

    hooks.renderShiftNotice(null);
    expect(notice.hidden).toBe(true);
    expect(notice.className).toBe('notice');
    expect(message.textContent).toBe('');
    expect(fix.hidden).toBe(true);
  });

  it('reads a bare SQLite timestamp as UTC, matching the server', () => {
    const { formatDateTime, normalizeTimestampInput } = loadFrontendHooks();

    // Asserted on the normalized string rather than the rendered output: this
    // suite runs in workerd, whose local zone is UTC, so a rendered comparison
    // would pass even without the zone suffix and prove nothing.
    expect(normalizeTimestampInput('2026-08-25 03:00:00')).toBe('2026-08-25T03:00:00Z');

    // An ISO string from a fresh sync already carries its zone; leave it alone.
    expect(normalizeTimestampInput('2026-08-25T03:00:00.000Z')).toBe('2026-08-25T03:00:00.000Z');

    // formatDateTime(new Date()) is also a valid call and must pass through.
    const now = new Date();
    expect(normalizeTimestampInput(now)).toBe(now);

    // Both server shapes are the same instant and must render identically.
    expect(formatDateTime('2026-08-25 03:00:00')).toBe(formatDateTime('2026-08-25T03:00:00.000Z'));
    expect(formatDateTime('not a timestamp')).toBe('');
  });

  it('surfaces absent, scheduled and incomplete days in the admin overview', () => {
    const hooks = loadFrontendHooks();
    hooks.renderAdminOverview([
      {
        display_name: '山田 太郎',
        summary: {
          office_days: 10,
          remote_days: 5,
          paid_leave_days: 1,
          absent_days: 2,
          scheduled_work_days: 20,
          incomplete_days: 3,
          total_work_minutes: 600,
          total_transport_fee: 4400,
        },
      },
      {
        display_name: '鈴木 花子',
        summary: {
          office_days: 20,
          remote_days: 0,
          paid_leave_days: 0,
          absent_days: 0,
          scheduled_work_days: 20,
          incomplete_days: 0,
          total_work_minutes: 9600,
          total_transport_fee: 8800,
        },
      },
    ]);

    const rows = hooks.getElement('admin-overview-body').children;
    expect(rows).toHaveLength(2);

    // The server already computes these; the table used to discard them.
    const [withGaps, complete] = rows;
    expect(withGaps.children).toHaveLength(9);
    expect(withGaps.children[4].textContent).toBe('2日'); // 欠勤
    expect(withGaps.children[5].textContent).toBe('20日'); // 所定
    expect(withGaps.children[6].textContent).toBe('3件'); // 未完了
    expect(withGaps.children[7].textContent).toBe('10:00'); // 実働
    expect(withGaps.classList.contains('is-incomplete-row')).toBe(true);

    // A month with nothing outstanding stays visually quiet.
    expect(complete.children[6].textContent).toBe('—');
    expect(complete.classList.contains('is-incomplete-row')).toBe(false);
  });

  it('still performs the action when the submit event carries no submitter', async () => {
    const { withBusy } = loadFrontendHooks();
    let performed = 0;

    // Programmatic submits and browsers without SubmitEvent.submitter must not
    // silently skip the save.
    await withBusy(null, '保存中…', async () => { performed += 1; });
    await withBusy(undefined, '保存中…', async () => { performed += 1; });
    expect(performed).toBe(2);

    // A disabled control still guards against a double submit.
    await withBusy({ disabled: true, innerHTML: '', textContent: '' }, '保存中…', async () => {
      performed += 1;
    });
    expect(performed).toBe(2);

    const button = { disabled: false, innerHTML: '<span>保存</span>', textContent: '保存' };
    await withBusy(button, '保存中…', async () => {
      expect(button.disabled).toBe(true);
      performed += 1;
    });
    expect(performed).toBe(3);
    expect(button.disabled).toBe(false);
    expect(button.innerHTML).toBe('<span>保存</span>');
  });

  it('does not let a forced month reload adopt a request that predates the write', async () => {
    const release: Array<() => void> = [];
    let requests = 0;
    const hooks = loadFrontendHooks((path) => {
      expect(path).toBe('/api/attendance/2026/7');
      requests += 1;
      const attempt = requests;
      return new Promise((resolve) => {
        release.push(() => resolve({
          year: 2026,
          month: 7,
          records: [],
          total_work_minutes: attempt * 100,
        }));
      });
    });

    const beforeWrite = hooks.loadMonthData('2026-07', false);
    const afterWrite = hooks.loadMonthData('2026-07', true);
    expect(requests).toBe(2);

    release[0]();
    release[1]();
    expect((await afterWrite).total_work_minutes).toBe(200);
    expect((await beforeWrite).total_work_minutes).toBe(100);

    // The superseded response must not be left behind in the cache either.
    expect((await hooks.loadMonthData('2026-07', false)).total_work_minutes).toBe(200);
    expect(requests).toBe(2);
  });
});
