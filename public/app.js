(function startAttendanceApp() {
  'use strict';

  const WORK_TYPES = Object.freeze({
    office: '出社',
    remote: '在宅',
    paid_leave: '有給',
    holiday: '休日',
    absent: '欠勤',
  });
  const TRIP_TYPES = Object.freeze({ one_way: '片道', round_trip: '往復' });
  const TRANSPORT_MODES = Object.freeze({
    rail: '鉄道',
    bus: 'バス',
    taxi: 'タクシー',
    other: 'その他',
  });
  const WEEKDAYS = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);
  const MONTH_TARGETS = Object.freeze(['calendar', 'summary', 'admin']);
  const MAX_SHIFT_MINUTES = 18 * 60;
  const MONTH_CACHE_TTL_MS = 30_000;
  const DEFAULT_CONFIG = Object.freeze({
    timezone: 'Asia/Tokyo',
    default_break_minutes: 60,
    default_one_way_fare: 210,
    default_trip_type: 'round_trip',
    default_clock_in: '10:00',
    default_clock_out: '19:00',
    overtime_threshold_hours: 180,
  });

  let _dtfMonth = null;

  const state = {
    config: { ...DEFAULT_CONFIG },
    user: null,
    today: null,
    page: 'today',
    calendarMonth: currentMonthValue(),
    summaryMonth: currentMonthValue(),
    adminMonth: currentMonthValue(),
    monthCache: new Map(),
    calendarSummary: null,
    summary: null,
    editorRecord: null,
    adminEditUser: null,
    clockTimer: null,
  };

  const DOM = {
    clockWorkingFields: null,
    recordWorkingFields: null,
    recordOfficeFields: null,
    pagePanels: null,
    pageButtons: null,
  };

  let clockTimeEdited = false;
  let editorSnapshot = null;

  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.data = data;
    }
  }

  const byId = (id) => document.getElementById(id);

  async function initialize() {
    applyStoredTheme();
    watchSystemTheme();
    bindEvents();
    startClock();
    MONTH_TARGETS.forEach(renderMonthControl);

    try {
      // /api/config and /api/auth/status do not depend on each other, so both
      // requests go out together instead of costing two serial round trips
      // before anything can render. They are still *consumed* in order, because
      // normalizeUser() reads the fetched config to fill in a user's missing
      // defaults.
      const statusRequest = api('/api/auth/status');
      // Keeps a rejection that lands while loadConfig() is still in flight from
      // surfacing as an unhandled rejection; loadAuthStatus re-observes it.
      statusRequest.catch(() => {});
      await loadConfig();
      cacheDOM();
      const status = await loadAuthStatus(statusRequest);
      if (status.authenticated && status.user) {
        await enterApplication(status.user);
      } else {
        showAuthentication(Boolean(status.setup_required));
      }
    } catch (error) {
      showAuthentication(false);
      toast(errorMessage(error, '初期化に失敗しました。'), 'error');
    } finally {
      byId('loading-view').hidden = true;
    }
  }

  function cacheDOM() {
    DOM.clockWorkingFields = document.querySelectorAll('[data-working-field]');
    DOM.recordWorkingFields = document.querySelectorAll('[data-record-working-field]');
    DOM.recordOfficeFields = document.querySelectorAll('[data-record-office-field]');
    DOM.pagePanels = document.querySelectorAll('[data-page-panel]');
    DOM.pageButtons = document.querySelectorAll('[data-page]');
  }

  function bindEvents() {
    byId('login-form').addEventListener('submit', handleLogin);
    byId('setup-form').addEventListener('submit', handleSetup);
    byId('logout-button').addEventListener('click', handleLogout);
    byId('theme-button').addEventListener('click', toggleTheme);

    // Using event delegation for page navigation and month control
    document.addEventListener('click', (event) => {
      const pageBtn = event.target.closest('[data-page]');
      if (pageBtn) {
        void navigate(pageBtn.dataset.page);
        return;
      }
      const deltaBtn = event.target.closest('[data-month-delta]');
      if (deltaBtn) {
        const target = deltaBtn.dataset.monthTarget;
        const delta = Number(deltaBtn.dataset.monthDelta);
        changeMonth(target, Number.isFinite(delta) ? delta : 0);
        return;
      }
      const currentBtn = event.target.closest('[data-month-current]');
      if (currentBtn) {
        setMonth(currentBtn.dataset.monthCurrent, currentMonthValue(), true);
        hapticFeedback();
        return;
      }
      const chip = event.target.closest('.chip-btn');
      if (chip) {
        const group = chip.closest('[data-preset-target]');
        if (group) {
          const targetId = group.dataset.presetTarget;
          const targetInput = byId(targetId);
          if (targetInput && !targetInput.disabled) {
            targetInput.value = chip.dataset.value;
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
            targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            hapticFeedback();
          }
        }
      }
    });

    // Year and month are two selects rather than <input type="month">: desktop
    // Safari recognizes that type but renders it as a bare text field.
    document.addEventListener('change', (event) => {
      const select = event.target.closest('[data-month-select]');
      if (!select) return;
      const target = select.dataset.monthSelect;
      const value = validMonthValue(
        `${byId(`${target}-year-select`)?.value}-${byId(`${target}-month-select`)?.value}`,
      );
      if (value) setMonth(target, value, true);
    });

    byId('clock-work-type').addEventListener('change', updateClockForm);
    byId('clock-in-time').addEventListener('input', () => { clockTimeEdited = true; });
    byId('clock-time-now-btn')?.addEventListener('click', () => {
      resetClockActionTime();
      hapticFeedback();
    });
    byId('clock-in-form').addEventListener('submit', handleClockIn);
    byId('clock-out-button').addEventListener('click', handleClockOut);
    byId('edit-today-button').addEventListener('click', () => {
      void openRecordEditor(todayIso());
    });
    byId('fix-stale-record-button')?.addEventListener('click', (event) => {
      const date = validDate(event.currentTarget.dataset.date);
      if (date) void openRecordEditor(date);
    });

    byId('apply-default-times-button')?.addEventListener('click', handleApplyDefaultTimes);

    byId('copy-summary-button')?.addEventListener('click', handleCopySummary);
    byId('print-summary-button')?.addEventListener('click', (event) => {
      event.preventDefault();
      if (!isSummaryReady()) return;
      byId('print-summary-button')?.blur();
      window.setTimeout(() => {
        if (isSummaryReady()) window.print();
      }, 60);
    });
    window.addEventListener('beforeprint', prepareSummaryPrint);
    window.addEventListener('afterprint', () => {
      restoreSummaryPrint();
      byId('main-content')?.focus({ preventScroll: true });
    });
    window.addEventListener('pageshow', () => {
      void refreshOnResume();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // The system appearance may have switched (Auto) while in background.
        renderThemeChrome();
        void refreshOnResume();
      }
    });
    byId('download-excel-button').addEventListener('click', handleExcelDownload);
    byId('profile-form').addEventListener('submit', handleProfileUpdate);
    byId('profile-display-name').addEventListener('input', updateExcelFilenamePreview);
    byId('work-defaults-form').addEventListener('submit', handleWorkDefaultsUpdate);
    byId('commute-form').addEventListener('submit', handleCommuteUpdate);
    byId('password-form').addEventListener('submit', handlePasswordUpdate);

    byId('close-record-dialog').addEventListener('click', closeRecordDialog);
    byId('cancel-record-button').addEventListener('click', closeRecordDialog);
    byId('record-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      closeRecordDialog();
    });
    byId('record-work-type').addEventListener('change', updateRecordForm);
    byId('record-one-way-fare').addEventListener('input', updateRecordFarePreview);
    byId('record-trip-type').addEventListener('change', updateRecordFarePreview);
    byId('record-form').addEventListener('submit', handleRecordSave);
    byId('reload-record-button').addEventListener('click', async () => {
      const date = state.editorRecord?.work_date;
      if (!date || !window.confirm('入力内容を破棄して最新の記録を読み込みますか？')) return;
      // Fetch first so a connection failure leaves the draft intact.
      await openRecordEditor(date);
    });
    byId('summary-retry-button').addEventListener('click', () => void loadSummary(true));
    byId('calendar-retry-button').addEventListener('click', () => void loadCalendar(true));
    byId('summary-incomplete-only').addEventListener('change', () => {
      if (isSummaryReady()) renderSummary(state.summary);
    });
    window.addEventListener('beforeunload', (event) => {
      if (!hasUnsavedRecord()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    byId('delete-record-button').addEventListener('click', handleRecordDelete);

    byId('admin-add-user-form').addEventListener('submit', handleAdminAddUser);
    byId('close-admin-user-dialog').addEventListener('click', closeAdminUserDialog);
    byId('cancel-admin-user-button').addEventListener('click', closeAdminUserDialog);
    byId('admin-user-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      closeAdminUserDialog();
    });
    byId('admin-user-form').addEventListener('submit', handleAdminUserSave);
    byId('admin-reset-password-button').addEventListener('click', () => void handleAdminPasswordReset());
    document.addEventListener('click', handleTimeStepper);
    window.addEventListener('keydown', handleKeyboardShortcuts);
  }

  function handleKeyboardShortcuts(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    // Any modal swallows the navigation digits, not just the record editor.
    const dialog = document.querySelector('dialog[open]');
    if (dialog) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (dialog.id === 'admin-user-dialog') closeAdminUserDialog();
        else closeRecordDialog();
      }
      return;
    }

    if (event.key === '1') { event.preventDefault(); void navigate('today'); }
    else if (event.key === '2') { event.preventDefault(); void navigate('calendar'); }
    else if (event.key === '3') { event.preventDefault(); void navigate('summary'); }
    else if (event.key === '4') { event.preventDefault(); void navigate('settings'); }
    else if (event.key === '5' && state.user?.is_admin) { event.preventDefault(); void navigate('admin'); }
  }

  function hapticFeedback(pattern = 12) {
    try {
      if (typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch { /* ignore */ }
  }

  function handleTimeStepper(event) {
    const btn = event.target.closest('[data-time-target]');
    if (!btn) return;
    const targetId = btn.dataset.timeTarget;
    const step = Number(btn.dataset.step) || 15;
    const input = byId(targetId);
    if (!input || input.disabled) return;

    const time = validTime(input.value) || nowTime();
    const parts = time.split(':').map(Number);
    let totalMinutes = parts[0] * 60 + parts[1] + step;
    if (totalMinutes < 0) totalMinutes += 1440;
    totalMinutes = totalMinutes % 1440;

    const newHours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const newMinutes = String(totalMinutes % 60).padStart(2, '0');
    input.value = `${newHours}:${newMinutes}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function loadConfig() {
    const source = unwrap(await api('/api/config'));
    state.config = {
      timezone: safeString(source.timezone, DEFAULT_CONFIG.timezone),
      default_break_minutes: boundedInteger(source.default_break_minutes, DEFAULT_CONFIG.default_break_minutes, 0, 480),
      default_one_way_fare: boundedInteger(source.default_one_way_fare, DEFAULT_CONFIG.default_one_way_fare, 0, 100000),
      default_trip_type: normalizeTripType(source.default_trip_type) || DEFAULT_CONFIG.default_trip_type,
      default_clock_in: validTime(source.default_clock_in) || DEFAULT_CONFIG.default_clock_in,
      default_clock_out: validTime(source.default_clock_out) || DEFAULT_CONFIG.default_clock_out,
      overtime_threshold_hours: boundedInteger(source.overtime_threshold_hours, DEFAULT_CONFIG.overtime_threshold_hours, 0, 744),
    };
  }

  async function loadAuthStatus(pendingRequest) {
    const status = unwrap(await (pendingRequest || api('/api/auth/status')));
    return {
      setup_required: Boolean(status.setup_required),
      authenticated: Boolean(status.authenticated),
      user: status.user ? normalizeUser(status.user) : null,
    };
  }

  function showAuthentication(setupRequired) {
    clearExcelDownload();
    // A modal left open (a session that expired mid-edit) sits in the top layer
    // above the login form and makes it inert, so it has to go first.
    if (byId('record-dialog')?.open) closeRecordDialog(true);
    if (byId('admin-user-dialog')?.open) closeAdminUserDialog();
    byId('app-view').hidden = true;
    byId('auth-view').hidden = false;
    syncThemeColor();
    byId('login-form').hidden = setupRequired;
    byId('setup-form').hidden = !setupRequired;
    byId('auth-description').textContent = setupRequired
      ? '最初の管理者アカウントを安全に作成します。'
      : 'ログインして勤務時間を記録します。';
    requestAnimationFrame(() => {
      const target = setupRequired ? byId('setup-token') : byId('login-username');
      target?.focus();
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    const username = byId('login-username').value.trim();
    const password = byId('login-password').value;
    if (!username || !password) {
      toast('ログイン名とパスワードを入力してください。', 'error');
      return;
    }

    await withBusy(event.submitter, 'ログイン中…', async () => {
      try {
        const response = await api('/api/auth/login', {
          method: 'POST',
          body: { username, password },
        });
        byId('login-password').value = '';
        await enterApplication(response.user);
        toast('ログインしました。', 'success');
      } catch (error) {
        toast(errorMessage(error, 'ログインできませんでした。'), 'error');
      }
    });
  }

  async function handleSetup(event) {
    event.preventDefault();
    const password = byId('setup-password').value;
    const confirmation = byId('setup-password-confirm').value;
    if (password !== confirmation) {
      toast('確認用パスワードが一致しません。', 'error');
      return;
    }
    if (password.length < 12 || password.length > 128) {
      toast('パスワードは12〜128文字にしてください。', 'error');
      return;
    }

    const username = normalizeNewUsername(byId('setup-username').value);
    if (!username) {
      toast('ログイン名は3〜64文字の英数字・ドット・下線・ハイフンで入力してください。', 'error');
      return;
    }

    const payload = {
      setup_token: byId('setup-token').value,
      username,
      display_name: byId('setup-display-name').value.trim(),
      password,
      default_one_way_fare: state.config.default_one_way_fare,
      default_trip_type: state.config.default_trip_type,
    };
    if (!payload.setup_token || !payload.username || !payload.display_name) {
      toast('セットアップトークン、ログイン名、氏名を入力してください。', 'error');
      return;
    }

    await withBusy(event.submitter, '作成中…', async () => {
      try {
        const response = await api('/api/auth/setup', { method: 'POST', body: payload });
        byId('setup-token').value = '';
        byId('setup-password').value = '';
        byId('setup-password-confirm').value = '';
        await enterApplication(response.user);
        toast('初期セットアップが完了しました。', 'success');
      } catch (error) {
        toast(errorMessage(error, '初期セットアップに失敗しました。'), 'error');
      }
    });
  }

  async function enterApplication(rawUser) {
    state.user = normalizeUser(rawUser);
    state.monthCache.clear();
    byId('auth-view').hidden = true;
    byId('app-view').hidden = false;
    syncThemeColor();
    renderUserIdentity();
    applyUserDefaults();
    await navigate('today');
  }

  async function handleLogout() {
    await withBusy(byId('logout-button'), '処理中…', async () => {
      let remoteFailed = false;
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) {
          remoteFailed = true;
        }
      }
      state.user = null;
      state.today = null;
      state.monthCache.clear();
      showAuthentication(false);
      toast(
        remoteFailed
          ? '画面をロックしました。サーバー側のログアウトは完了していない可能性があります。'
          : 'ログアウトしました。',
        remoteFailed ? 'error' : 'success',
      );
    });
  }

  function renderUserIdentity() {
    byId('header-user-name').textContent = state.user.display_name || state.user.username;
    byId('header-user-role').textContent = state.user.is_admin ? '管理者' : '一般';
    byId('admin-nav-button').hidden = !state.user.is_admin;
    byId('profile-username').value = state.user.username;
    // defaultValue, so the password form's reset() after a change keeps it.
    byId('password-form-username').defaultValue = state.user.username;
    byId('profile-display-name').value = state.user.display_name;
    byId('profile-one-way-fare').value = String(userOneWayFare());
    byId('profile-trip-type').value = userTripType();
    byId('profile-clock-in').value = userClockIn();
    byId('profile-clock-out').value = userClockOut();
    byId('profile-break').value = String(userBreakMinutes());
    byId('profile-work-type').value = userWorkType();
    byId('profile-transport-mode').value = userTransportMode();
    byId('profile-transport-origin').value = userTransportOrigin();
    byId('profile-transport-destination').value = userTransportDestination();
    updateExcelFilenamePreview();
  }

  function applyUserDefaults() {
    byId('clock-break').value = String(userBreakMinutes());
    resetClockActionTime();
    byId('clock-work-type').value = userWorkType();
    updateClockForm();
  }

  async function navigate(page) {
    const allowed = new Set(['today', 'calendar', 'summary', 'settings', 'admin']);
    const nextPage = allowed.has(page) ? page : 'today';
    if (nextPage === 'admin' && !state.user?.is_admin) return;
    state.page = nextPage;

    DOM.pagePanels.forEach((panel) => {
      const active = panel.dataset.pagePanel === nextPage;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    DOM.pageButtons.forEach((button) => {
      const active = button.dataset.page === nextPage;
      button.classList.toggle('is-active', active);
      if (active) {
        button.setAttribute('aria-current', 'page');
        // When the tab strip does scroll (a larger text size), keep the
        // current tab (e.g. 管理 at the far end) from sitting clipped.
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } else {
        button.removeAttribute('aria-current');
      }
    });

    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

    if (nextPage === 'today') await loadToday();
    if (nextPage === 'calendar') await loadCalendar(false);
    if (nextPage === 'summary') await loadSummary(false);
    if (nextPage === 'admin') await loadAdminPage();
    byId('main-content').focus({ preventScroll: true });
  }

  async function loadToday(preserveDraft = false) {
    try {
      const raw = await api('/api/attendance/today');
      const next = normalizeToday(raw);
      // Resume refreshes must not overwrite a form being filled in. Reset it
      // only when the underlying shift changed, including on another device.
      const unchanged = state.today && todayRecordKey(state.today) === todayRecordKey(next);
      state.today = next;
      renderToday(preserveDraft && unchanged);
      return true;
    } catch (error) {
      handleAuthenticatedError(error, '今日の記録を取得できませんでした。');
      return false;
    }
  }

  function todayRecordKey(today) {
    return JSON.stringify([today.date, ...['record', 'active_record', 'stale_record'].map((key) => {
      const record = today[key];
      return record ? [record.id, record.revision] : null;
    })]);
  }

  function normalizeToday(raw) {
    const source = unwrap(raw);
    const date = validDate(source.date) || todayIso();
    const defaults = unwrap(source.defaults || {});
    const oneWayFare = boundedInteger(
      defaults.one_way_fare ?? defaults.transport_one_way_fee,
      userOneWayFare(),
      0,
      100000,
    );
    const tripType = normalizeTripType(defaults.trip_type ?? defaults.transport_trip_type) || userTripType();
    return {
      date,
      day_of_week: boundedInteger(source.day_of_week, weekdayIndex(date), 0, 6),
      is_holiday: Boolean(source.is_holiday),
      is_weekend: Boolean(source.is_weekend),
      holiday_name: safeString(source.holiday_name, ''),
      record: source.record ? normalizeRecord(source.record, {
        date,
        day_of_week: source.day_of_week,
        is_holiday: source.is_holiday,
        holiday_name: source.holiday_name,
      }) : null,
      active_record: source.active_record ? normalizeRecord(source.active_record, {
        date: source.active_record.work_date,
        day_of_week: weekdayIndex(source.active_record.work_date),
      }) : null,
      stale_record: source.stale_record ? normalizeRecord(source.stale_record, {
        date: source.stale_record.work_date,
        day_of_week: weekdayIndex(source.stale_record.work_date),
      }) : null,
      defaults: {
        break_minutes: boundedInteger(defaults.break_minutes, state.config.default_break_minutes, 0, 480),
        work_type: workingType(defaults.work_type) || userWorkType(),
        one_way_fare: oneWayFare,
        trip_type: tripType,
        transport_mode: normalizeTransportMode(defaults.transport_mode) || userTransportMode(),
        transport_origin: safeString(defaults.transport_origin, userTransportOrigin()).slice(0, 120),
        transport_destination: safeString(defaults.transport_destination, userTransportDestination()).slice(0, 120),
      },
    };
  }

  function createDayIcon(type) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'today-day-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (type === 'holiday') {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '3');
      rect.setAttribute('y', '4');
      rect.setAttribute('width', '18');
      rect.setAttribute('height', '18');
      rect.setAttribute('rx', '2');
      rect.setAttribute('ry', '2');
      const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l1.setAttribute('x1', '16'); l1.setAttribute('y1', '2'); l1.setAttribute('x2', '16'); l1.setAttribute('y2', '6');
      const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l2.setAttribute('x1', '8'); l2.setAttribute('y1', '2'); l2.setAttribute('x2', '8'); l2.setAttribute('y2', '6');
      const l3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l3.setAttribute('x1', '3'); l3.setAttribute('y1', '10'); l3.setAttribute('x2', '21'); l3.setAttribute('y2', '10');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '12'); circle.setAttribute('cy', '16'); circle.setAttribute('r', '2.2');
      circle.setAttribute('fill', 'currentColor');
      svg.append(rect, l1, l2, l3, circle);
    } else {
      const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p1.setAttribute('d', 'M18 8h1a4 4 0 0 1 0 8h-1');
      const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p2.setAttribute('d', 'M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z');
      const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l1.setAttribute('x1', '6'); l1.setAttribute('y1', '1'); l1.setAttribute('x2', '6'); l1.setAttribute('y2', '4');
      const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l2.setAttribute('x1', '10'); l2.setAttribute('y1', '1'); l2.setAttribute('x2', '10'); l2.setAttribute('y2', '4');
      const l3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l3.setAttribute('x1', '14'); l3.setAttribute('y1', '1'); l3.setAttribute('x2', '14'); l3.setAttribute('y2', '4');
      svg.append(p1, p2, l1, l2, l3);
    }
    return svg;
  }

  function renderToday(preserveDraft = false) {
    const today = state.today;
    const record = today.record;
    const activeRecord = today.active_record;
    const staleRecord = today.stale_record;
    byId('today-date').textContent = formatJapaneseDate(today.date);

    const weekdayEl = byId('today-weekday');
    const holidayEl = byId('today-holiday');

    weekdayEl.textContent = `${WEEKDAYS[today.day_of_week] || ''}曜日`;
    if (today.is_holiday) {
      weekdayEl.dataset.type = 'holiday';
    } else if (today.day_of_week === 0) {
      weekdayEl.dataset.type = 'sunday';
    } else if (today.day_of_week === 6) {
      weekdayEl.dataset.type = 'saturday';
    } else {
      weekdayEl.dataset.type = 'workday';
    }

    holidayEl.replaceChildren();
    if (today.is_holiday) {
      holidayEl.dataset.type = 'holiday';
      holidayEl.hidden = false;
      const icon = createDayIcon('holiday');
      const text = document.createElement('span');
      text.textContent = today.holiday_name || '祝日';
      holidayEl.append(icon, text);
    } else {
      holidayEl.dataset.type = '';
      holidayEl.hidden = true;
    }

    byId('today-record-type').textContent = record?.persisted ? workTypeLabel(record.work_type) : '未定';
    byId('today-record-in').textContent = record?.clock_in || '--:--';
    byId('today-record-out').textContent = record?.clock_out || '--:--';
    byId('today-record-break').textContent = record?.persisted && isWorking(record.work_type)
      ? `${record.break_minutes}分`
      : '0分';
    byId('today-record-fare').textContent = money(record?.transport_fee || 0);
    renderTodayWorkTime(record);
    byId('today-record-transport-mode').textContent = record?.persisted && record.work_type === 'office'
      ? transportModeLabel(record.transport_mode)
      : '—';
    byId('today-record-route').textContent = record?.persisted && record.work_type === 'office'
      ? commuteRouteLabel(record.transport_origin, record.transport_destination)
      : '—';

    const todayState = attendanceState(
      record || normalizeRecord({}, {
        date: today.date,
        day_of_week: today.day_of_week,
        is_holiday: today.is_holiday,
        holiday_name: today.holiday_name,
      }),
      today.date,
      today.date,
    );

    const badge = byId('today-record-badge');
    let status = 'empty';
    let label = '未定';

    renderShiftNotice(null);

    if (staleRecord) {
      status = 'incomplete';
      label = '未退勤あり';
      byId('clock-out-button').disabled = true;
      byId('clock-in-button').disabled = true;
      // Both punch buttons are disabled here, so the notice has to carry the
      // only way forward instead of sending the user off to find the day.
      renderShiftNotice(
        'warning',
        `前日（${formatJapaneseDate(staleRecord.work_date)}）${staleRecord.clock_in} の未退勤記録があります。`,
        staleRecord.work_date,
      );
    } else if (activeRecord) {
      if (activeRecord.work_date === today.date) {
        status = 'working';
        label = '勤務中';
        byId('clock-out-button').disabled = false;
        byId('clock-in-button').disabled = true;
      } else if (activeRecord.work_date === previousDate(today.date)) {
        status = 'working';
        label = '勤務中（前日）';
        byId('clock-out-button').disabled = false;
        byId('clock-in-button').disabled = true;
        // 退勤 still works, so this one is informational only.
        renderShiftNotice(
          'info',
          `前日（${formatJapaneseDate(activeRecord.work_date)}）${activeRecord.clock_in} から勤務中です。退勤すると前日の勤務記録に保存されます。`,
        );
      }
    } else {
      byId('clock-out-button').disabled = true;
      byId('clock-in-button').disabled = Boolean(record?.clock_in || (record?.persisted && !isWorking(record.work_type)));
      if (todayState === 'undecided') {
        status = 'empty';
        label = '未定';
      } else if (record?.persisted) {
        status = 'done';
        label = '記録済み';
      } else if (today.is_holiday) {
        status = 'holiday';
        label = today.holiday_name || '祝日';
      } else if (today.day_of_week === 0 || today.day_of_week === 6) {
        status = 'weekend';
        label = '休日';
      } else {
        status = 'empty';
        label = '未定';
      }
    }

    badge.dataset.status = status;
    badge.textContent = label;

    const punchRecord = activeRecord || (
      record?.persisted && isWorking(record.work_type) && !record.clock_out
        ? record
        : null
    );
    if (!preserveDraft) {
      byId('clock-break').value = String(
        punchRecord?.break_minutes ?? today.defaults.break_minutes
      );
      if (!record?.persisted) byId('clock-work-type').value = today.defaults.work_type;
    }
    updateClockForm();
  }

  /**
   * Single owner of the punch-card notice. `kind` null clears it; `fixDate`
   * reveals the inline repair action for a day the user can no longer punch.
   */
  function renderShiftNotice(kind, message, fixDate) {
    const noticeEl = byId('today-active-shift-notice');
    const messageEl = byId('today-active-shift-message');
    const fixButton = byId('fix-stale-record-button');
    if (!noticeEl || !messageEl || !fixButton) return;

    if (!kind) {
      noticeEl.hidden = true;
      noticeEl.className = 'notice';
      messageEl.textContent = '';
      fixButton.hidden = true;
      fixButton.dataset.date = '';
      return;
    }

    noticeEl.hidden = false;
    noticeEl.className = `notice notice-${kind}`;
    messageEl.textContent = message;
    const repairable = Boolean(validDate(fixDate));
    fixButton.hidden = !repairable;
    fixButton.dataset.date = repairable ? fixDate : '';
  }

  function renderTodayWorkTime(record) {
    const container = byId('today-record-work');
    if (!container) return;
    const card = container.closest('div');
    const existingPulse = card?.querySelector('.live-work-pulse');
    if (record?.persisted && isWorking(record.work_type) && record.clock_in && !record.clock_out) {
      const startMin = timeToMinutes(record.clock_in);
      const currentMin = timeToMinutes(nowTime());
      if (startMin !== null && currentMin !== null) {
        // Today's record started today, so a start later than now is a punch
        // set ahead of time (e.g. to the official start), not an overnight
        // shift; wrapping it around midnight would show ~23 hours.
        container.textContent = formatMinutes(Math.max(0, currentMin - startMin));
        if (card && !existingPulse) {
          const pulse = createElement('span', { className: 'live-work-pulse', ariaHidden: 'true' });
          card.append(pulse);
        }
        return;
      }
    }
    if (existingPulse) existingPulse.remove();
    container.textContent = formatMinutes(record?.work_minutes || 0);
  }

  function updateClockForm() {
    const type = normalizeWorkType(byId('clock-work-type').value) || 'office';
    const working = isWorking(type);
    DOM.clockWorkingFields.forEach((field) => {
      field.hidden = !working;
      field.querySelectorAll('input, select').forEach((input) => { input.disabled = !working; });
    });
    byId('clock-in-button').textContent = working ? '出勤' : `${workTypeLabel(type)}として記録`;
  }

  function updateRecordFarePreview() {
    const type = normalizeWorkType(byId('record-work-type').value);
    const fare = type === 'office' ? boundedInteger(byId('record-one-way-fare').value, 0, 0, 100000) : 0;
    const tripVal = byId('record-trip-type').value;
    const multiplier = tripVal === 'round_trip' ? 2 : (tripVal === 'one_way' ? 1 : 0);
    byId('record-fare-preview').textContent = money(fare * multiplier);
  }

  async function handleClockIn(event) {
    event.preventDefault();
    const type = normalizeWorkType(byId('clock-work-type').value);
    if (!type) {
      toast('勤務区分が不正です。', 'error');
      return;
    }

    let breakMinutes = userBreakMinutes();
    if (isWorking(type)) {
      try {
        breakMinutes = readIntegerInput(byId('clock-break'), '休憩時間', 0, 480);
      } catch (err) {
        if (err instanceof InputValidationError) {
          toast(err.message, 'error');
          return;
        }
        throw err;
      }
    }

    const date = todayIso();
    if (state.today?.date !== date) {
      await loadToday();
    }

    await withBusy(event.submitter, '記録中…', async () => {
      try {
        if (!isWorking(type)) {
          await api(`/api/attendance/${encodeURIComponent(date)}`, {
            method: 'PUT',
            body: clearedNonWorkingRecord(type, ''),
            headers: recordVersionHeaders(state.today?.record),
          });
        } else {
          const clockIn = clockActionTime();
          const body = {
            work_type: type,
            clock_in: clockIn,
            break_minutes: breakMinutes,
            transport_one_way_fee: type === 'office' ? userOneWayFare() : 0,
            transport_trip_type: type === 'office' ? userTripType() : 'one_way',
            transport_mode: type === 'office' ? userTransportMode() : 'rail',
            transport_origin: type === 'office' ? userTransportOrigin() : '',
            transport_destination: type === 'office' ? userTransportDestination() : '',
          };
          await api('/api/attendance/clock-in', { method: 'POST', body });
        }
        state.monthCache.clear();
        await loadToday();
        resetClockActionTime();
        toast('勤務を記録しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, '勤務を記録できませんでした。');
      }
    });
    if (state.today) renderToday();
  }

  async function handleClockOut() {
    const clockOut = clockActionTime();

    let breakMinutes;
    try {
      breakMinutes = readIntegerInput(byId('clock-break'), '休憩時間', 0, 480);
    } catch (error) {
      if (error instanceof InputValidationError) {
        toast(error.message, 'error');
        return;
      }
      throw error;
    }

    if (!window.confirm(`${clockOut} で退勤を記録しますか？`)) return;
    await withBusy(byId('clock-out-button'), '記録中…', async () => {
      try {
        await api('/api/attendance/clock-out', {
          method: 'POST',
          body: {
            clock_out: clockOut,
            break_minutes: breakMinutes,
          },
        });
        state.monthCache.clear();
        await loadToday();
        resetClockActionTime();
        toast('退勤を記録しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, '退勤を記録できませんでした。');
      }
    });
    if (state.today) renderToday();
  }

  let calendarRequestVersion = 0;
  async function loadCalendar(force) {
    const version = ++calendarRequestVersion;
    const requestedMonth = state.calendarMonth;
    state.calendarSummary = null;
    byId('calendar-grid').replaceChildren();
    setMonthStatus('calendar', '読み込み中…');
    try {
      const summary = await loadMonthData(requestedMonth, force);
      if (version !== calendarRequestVersion || requestedMonth !== state.calendarMonth) return true;
      state.calendarSummary = summary;
      renderCalendar(summary);
      setMonthStatus('calendar', '最新の記録を表示しています。');
      return true;
    } catch (error) {
      if (version !== calendarRequestVersion) return true;
      setMonthStatus('calendar', '読み込めませんでした。再試行してください。', true);
      handleAuthenticatedError(error, 'カレンダーを取得できませんでした。');
      return false;
    }
  }

  function renderCalendar(summary) {
    const grid = byId('calendar-grid');
    grid.replaceChildren();
    WEEKDAYS.forEach((day) => grid.append(createElement('div', { className: 'calendar-header', text: day })));
    const firstDay = new Date(Date.UTC(summary.year, summary.month - 1, 1)).getUTCDay();
    for (let index = 0; index < firstDay; index += 1) {
      grid.append(createElement('div', { className: 'calendar-empty', ariaHidden: 'true' }));
    }

    const recordMap = new Map(summary.records.map((record) => [record.work_date, record]));
    const days = new Date(Date.UTC(summary.year, summary.month, 0)).getUTCDate();
    const today = todayIso();
    for (let day = 1; day <= days; day += 1) {
      const date = `${summary.year}-${String(summary.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const record = recordMap.get(date) || normalizeRecord({}, { date });
      const button = createElement('button', {
        className: 'calendar-day',
        type: 'button',
        ariaLabel: `${formatJapaneseDate(date)}の勤務を編集`,
      });
      if (date === today) button.classList.add('is-today');
      if (record.is_holiday) button.classList.add('is-holiday');
      if (record.day_of_week === 0) button.classList.add('is-sunday');
      if (record.day_of_week === 6) button.classList.add('is-saturday');

      const stateType = attendanceState(record, date, today);
      if (stateType === 'incomplete' || stateType === 'missing') {
        button.classList.add('is-incomplete');
      }

      button.append(createElement('span', { className: 'calendar-date', text: String(day) }));

      if (stateType === 'incomplete') {
        const badge = createElement('span', { className: 'type-badge', text: '未退' });
        badge.dataset.type = 'incomplete-no-out';
        button.append(badge);
      } else if (stateType === 'missing') {
        const badge = createElement('span', { className: 'type-badge', text: '未刻' });
        badge.dataset.type = 'incomplete-missing';
        button.append(badge);
      } else if (stateType === 'undecided') {
        const badge = createElement('span', { className: 'type-badge', text: '未定' });
        badge.dataset.type = 'undecided';
        button.append(badge);
      } else if (stateType === 'active') {
        const badge = createElement('span', { className: 'type-badge', text: '勤務中' });
        badge.dataset.type = 'working';
        button.append(badge);
      } else if (record.persisted) {
        const badge = createElement('span', { className: 'type-badge', text: workTypeLabel(record.work_type) });
        badge.dataset.type = record.work_type || 'unknown';
        button.append(badge);
      } else if (record.is_holiday) {
        const badge = createElement('span', { className: 'type-badge holiday-badge' });
        badge.dataset.type = 'holiday';
        const icon = createDayIcon('holiday');
        const text = document.createElement('span');
        text.textContent = record.holiday_name || '祝日';
        badge.append(icon, text);
        button.append(badge);
      } else if (record.day_of_week === 0 || record.day_of_week === 6) {
        const badge = createElement('span', { className: 'type-badge', text: '休日' });
        badge.dataset.type = record.day_of_week === 6 ? 'saturday' : 'sunday';
        button.append(badge);
      }

      const note = record.persisted && record.clock_in
        ? `${record.clock_in}–${record.clock_out || (stateType === 'active' ? '勤務中' : '未退')}`
        : record.holiday_name;
      if (note) button.append(createElement('span', { className: 'calendar-note', text: note }));
      button.addEventListener('click', () => void openRecordEditor(date));
      grid.append(button);
    }

    renderHolidaySourceNote(byId('calendar-holiday-source-note'), summary.holiday_data);
  }

  function setMonthStatus(target, message, failed = false) {
    byId(`${target}-load-status`).textContent = message;
    byId(`${target}-retry-button`).hidden = !failed;
  }

  function isSummaryReady() {
    return Boolean(state.summary
      && state.summaryMonth === `${state.summary.year}-${String(state.summary.month).padStart(2, '0')}`);
  }

  function setSummaryActions(enabled) {
    ['copy-summary-button', 'print-summary-button', 'summary-incomplete-only'].forEach((id) => {
      byId(id).disabled = !enabled;
    });
  }

  let printState = null;
  function prepareSummaryPrint() {
    if (printState || !isSummaryReady() || state.page !== 'summary') return;
    const details = byId('summary-extra');
    const filter = byId('summary-incomplete-only');
    printState = { detailsOpen: details.open, incompleteOnly: filter.checked };
    details.open = true;
    filter.checked = false;
    renderSummary(state.summary);
  }

  function restoreSummaryPrint() {
    if (!printState) return;
    byId('summary-extra').open = printState.detailsOpen;
    byId('summary-incomplete-only').checked = printState.incompleteOnly;
    printState = null;
    if (isSummaryReady()) renderSummary(state.summary);
  }

  let summaryRequestVersion = 0;
  async function loadSummary(force) {
    const version = ++summaryRequestVersion;
    const requestedMonth = state.summaryMonth;
    state.summary = null;
    setSummaryActions(false);
    byId('summary-metrics').replaceChildren();
    byId('summary-extra-metrics').replaceChildren();
    byId('summary-table-body').replaceChildren();
    byId('summary-print-month').textContent = '';
    byId('holiday-source-note').textContent = '';
    setMonthStatus('summary', '読み込み中…');
    try {
      const summary = await loadMonthData(requestedMonth, force);
      if (version !== summaryRequestVersion || requestedMonth !== state.summaryMonth) return true;
      state.summary = summary;
      renderSummary(summary);
      setSummaryActions(true);
      setMonthStatus('summary', '最新の記録を表示しています。');
      return true;
    } catch (error) {
      if (version !== summaryRequestVersion) return true;
      setMonthStatus('summary', '読み込めませんでした。再試行してください。', true);
      handleAuthenticatedError(error, '月次集計を取得できませんでした。');
      return false;
    }
  }

  function renderSummary(summary) {
    const { year, month } = summary;
    const monthText = `${year}年${String(month).padStart(2, '0')}月`;
    const employeeName = state.user?.display_name || state.user?.username || '氏名未設定';
    const printMonth = byId('summary-print-month');
    const printUser = byId('summary-print-user');
    const printGen = byId('summary-print-generated');
    if (printMonth) printMonth.textContent = `対象月: ${monthText}`;
    if (printUser) printUser.textContent = `氏名: ${employeeName}`;
    if (printGen) printGen.textContent = `出力日時: ${formatDateTime(new Date())}`;

    const primaryMetrics = [
      ['総実働', formatMinutes(summary.total_work_minutes)],
      ['勤務日数', `${summary.office_days + summary.remote_days}日`],
      ['要確認', `${summary.incomplete_days}件`],
    ];
    const metrics = [
      ['出社', `${summary.office_days}日`],
      ['在宅', `${summary.remote_days}日`],
      ['有給', `${summary.paid_leave_days}日`],
      ['欠勤', `${summary.absent_days}日`],
      ['所定勤務日数', `${summary.scheduled_work_days || 0}日`],
      ['会社基準超過', formatMinutes(summary.overtime_minutes)],
      ['交通費', money(summary.total_transport_fee)],
    ];
    const metricCard = ([label, value]) => {
      const card = createElement('div', { className: 'metric-card' });
      card.append(createElement('span', { text: label }), createElement('strong', { text: value }));
      return card;
    };
    byId('summary-metrics').replaceChildren(...primaryMetrics.map(metricCard));
    byId('summary-extra-metrics').replaceChildren(...metrics.map(metricCard));

    const today = todayIso();
    const body = byId('summary-table-body');
    body.replaceChildren();
    for (const record of summary.records) {
      const row = document.createElement('tr');
      const dateStr = record.work_date;
      const stateType = attendanceState(record, dateStr, today);
      if (byId('summary-incomplete-only').checked && !['incomplete', 'missing'].includes(stateType)) continue;

      if (stateType === 'incomplete' || stateType === 'missing') {
        row.classList.add('is-incomplete-row');
      }

      let typeLabel = '';
      if (stateType === 'missing') {
        typeLabel = '未刻';
      } else if (stateType === 'undecided') {
        typeLabel = '未定';
      } else if (record.persisted) {
        typeLabel = workTypeLabel(record.work_type);
      } else if (record.is_holiday) {
        typeLabel = record.holiday_name ? `祝日(${record.holiday_name})` : '祝日';
      } else if (record.day_of_week === 0 || record.day_of_week === 6) {
        typeLabel = '休日';
      }

      let clockOutText = '';
      if (record.persisted) {
        if (record.clock_out) {
          clockOutText = record.clock_out;
        } else if (stateType === 'active') {
          clockOutText = '勤務中';
        } else if (stateType === 'incomplete') {
          clockOutText = '未退';
        }
      }

      const values = [
        `${Number(record.work_date.slice(8))}日（${WEEKDAYS[record.day_of_week] || ''}）`,
        typeLabel,
        record.persisted ? (record.clock_in || '') : '',
        clockOutText,
        record.persisted && isWorking(record.work_type) ? `${record.break_minutes}分` : '',
        record.persisted && record.work_minutes !== null ? formatMinutes(record.work_minutes) : '',
        record.persisted && record.work_type === 'office' ? transportModeLabel(record.transport_mode) : '',
        record.persisted && record.work_type === 'office'
          ? commuteRouteLabel(record.transport_origin, record.transport_destination, '')
          : '',
        record.persisted && record.work_type === 'office' ? money(record.transport_one_way_fee) : '',
        record.persisted && record.work_type === 'office' ? tripTypeLabel(record.transport_trip_type) : '',
        record.persisted && record.work_type === 'office' ? money(record.transport_fee) : '',
      ];
      values.forEach((value, index) => {
        const cell = createElement('td', { text: index === 0 ? '' : value });
        if (index === 0) {
          const editButton = createElement('button', { className: 'text-button-link', text: value });
          editButton.type = 'button';
          editButton.setAttribute('aria-label', `${formatJapaneseDate(dateStr)}の記録を編集`);
          editButton.addEventListener('click', () => void openRecordEditor(dateStr));
          cell.append(editButton);
        }
        row.append(cell);
      });
      body.append(row);
    }
    if (!body.children.length) {
      const row = document.createElement('tr');
      const cell = createElement('td', { className: 'empty-table-cell', text: byId('summary-incomplete-only').checked ? '確認が必要な記録はありません。' : '記録がありません。' });
      cell.colSpan = 11;
      row.append(cell);
      body.append(row);
    }

    renderHolidaySourceNote(byId('holiday-source-note'), summary.holiday_data);
  }

  const HOLIDAY_SOURCE_LABELS = Object.freeze({
    cache: '保存済みの祝日データ',
    'official-csv': '内閣府の祝日CSV',
    'rule-based': '通用ルールによる推算（特例の祝日移動等は反映されません）',
    unavailable: '祝日データを取得できませんでした',
  });

  /** Calendar and Summary each carry their own copy of this note. */
  function renderHolidaySourceNote(note, holidayData) {
    if (!note) return;
    const holiday = holidayData || {};
    const label = HOLIDAY_SOURCE_LABELS[holiday.source] || '取得元不明';
    const syncedAt = holiday.synced_at ? `（同期：${formatDateTime(holiday.synced_at)}）` : '';
    note.textContent = `祝日情報：${label}${syncedAt}`;
    note.dataset.incomplete = holiday.complete === false ? 'true' : 'false';
  }

  let excelScriptLoading = null;
  async function ensureExcelLibrary() {
    if (window.KintaiExcel) return;
    if (!excelScriptLoading) {
      excelScriptLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/excel.js';
        script.onload = () => {
          if (!window.KintaiExcel) {
            script.remove();
            excelScriptLoading = null;
            reject(new Error('Excel出力モジュールの初期化に失敗しました。'));
            return;
          }
          resolve();
        };
        script.onerror = () => {
          script.remove();
          excelScriptLoading = null;
          reject(new Error('Excel出力モジュールの読み込みに失敗しました。'));
        };
        document.head.append(script);
      });
    }
    await excelScriptLoading;
  }

  async function handleExcelDownload() {
    if (!state.user) return;
    clearExcelDownload();
    const version = excelDownloadVersion;
    const requestedMonth = state.summaryMonth;
    const button = byId('download-excel-button');
    await withBusy(button, '作成中…', async () => {
      try {
        await ensureExcelLibrary();
        const [year, month] = splitMonth(requestedMonth);
        const raw = await api(`/api/export/${year}/${month}`);
        if (version !== excelDownloadVersion || !state.user || requestedMonth !== state.summaryMonth) return;
        const source = { ...unwrap(raw) };
        if (!source.username) source.username = state.user.username;
        if (!source.employee_name) source.employee_name = state.user.display_name;
        if (source.default_one_way_fare === undefined) source.default_one_way_fare = userOneWayFare();
        if (!source.default_trip_type) source.default_trip_type = userTripType();
        if (!source.default_transport_mode) source.default_transport_mode = userTransportMode();
        if (source.default_transport_origin === undefined) source.default_transport_origin = userTransportOrigin();
        if (source.default_transport_destination === undefined) source.default_transport_destination = userTransportDestination();
        const blob = window.KintaiExcel.createWorkbookBlob(source, { config: state.config });
        const filename = window.KintaiExcel.filenameFor(source);
        downloadBlob(blob, filename);
        hapticFeedback();
        toast('Excelを作成しました。保存されない場合はダウンロードリンクを押してください。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, 'Excelを作成できませんでした。');
      }
    });
  }

  async function handleCopySummary() {
    if (!isSummaryReady()) return;
    const s = state.summary;
    const { year, month } = s;
    const name = state.user?.display_name || state.user?.username || '氏名未設定';
    const lines = [
      `【${year}年${String(month).padStart(2, '0')}月 勤怠概要】`,
      `氏名：${name}`,
      `出社：${s.office_days}日 / 在宅：${s.remote_days}日 / 有給：${s.paid_leave_days}日 / 欠勤：${s.absent_days}日`,
      `総実働時間：${formatMinutes(s.total_work_minutes)}（会社基準超過：${formatMinutes(s.overtime_minutes)}）`,
      `交通費合計：${money(s.total_transport_fee)}`,
    ];
    if (s.incomplete_days > 0) {
      lines.push(`※未完了の記録が ${s.incomplete_days} 件あります`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      hapticFeedback();
      toast('勤怠サマリーをクリップボードにコピーしました。', 'success');
    } catch {
      toast('クリップボードへのコピーに失敗しました。', 'error');
    }
  }

  async function handleProfileUpdate(event) {
    event.preventDefault();
    const displayName = byId('profile-display-name').value.trim();
    if (!displayName) {
      toast('氏名を入力してください。', 'error');
      return;
    }
    const body = {
      display_name: displayName,
    };
    await saveProfileChanges(event.submitter, body, 'プロフィールを保存しました。');
  }

  async function handleWorkDefaultsUpdate(event) {
    event.preventDefault();
    let defaultBreakMinutes;
    try {
      defaultBreakMinutes = readIntegerInput(byId('profile-break'), '既定の休憩時間', 0, 480);
    } catch (err) {
      if (err instanceof InputValidationError) {
        toast(err.message, 'error');
        return;
      }
      throw err;
    }
    const body = {
      default_clock_in: validTime(byId('profile-clock-in').value) || null,
      default_clock_out: validTime(byId('profile-clock-out').value) || null,
      default_break_minutes: defaultBreakMinutes,
      default_work_type: workingType(byId('profile-work-type').value) || 'office',
    };
    await saveProfileChanges(event.submitter, body, '勤務の既定値を保存しました。');
  }

  async function handleCommuteUpdate(event) {
    event.preventDefault();
    let defaultOneWayFare;
    try {
      defaultOneWayFare = readIntegerInput(byId('profile-one-way-fare'), '既定の片道運賃', 0, 100000, {
        allowEmpty: true,
        emptyValue: null,
      });
    } catch (err) {
      if (err instanceof InputValidationError) {
        toast(err.message, 'error');
        return;
      }
      throw err;
    }
    const body = {
      default_one_way_fare: defaultOneWayFare,
      default_trip_type: normalizeTripType(byId('profile-trip-type').value) || 'round_trip',
      default_transport_mode: normalizeTransportMode(byId('profile-transport-mode').value) || 'rail',
      default_transport_origin: commuteLocationInput(byId('profile-transport-origin')),
      default_transport_destination: commuteLocationInput(byId('profile-transport-destination')),
    };
    await saveProfileChanges(event.submitter, body, '通勤設定を保存しました。');
  }

  async function saveProfileChanges(button, body, successMessage) {
    await withBusy(button, '保存中…', async () => {
      try {
        const response = await api('/api/auth/profile', { method: 'PATCH', body });
        state.user = normalizeUser(response.user);
        renderUserIdentity();
        applyUserDefaults();
        state.monthCache.clear();
        toast(successMessage, 'success');
      } catch (error) {
        handleAuthenticatedError(error, '個人設定を保存できませんでした。');
      }
    });
  }

  async function handlePasswordUpdate(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const currentPassword = byId('current-password').value;
    const newPassword = byId('new-password').value;
    const confirmation = byId('new-password-confirm').value;
    if (currentPassword.length < 1 || currentPassword.length > 128) {
      toast('現在のパスワードを正しく入力してください。', 'error');
      return;
    }
    if (newPassword.length < 12 || newPassword.length > 128) {
      toast('新しいパスワードは12〜128文字にしてください。', 'error');
      return;
    }
    if (newPassword !== confirmation) {
      toast('確認用パスワードが一致しません。', 'error');
      return;
    }
    if (currentPassword === newPassword) {
      toast('新しいパスワードは現在と異なるものにしてください。', 'error');
      return;
    }
    await withBusy(event.submitter, '変更中…', async () => {
      try {
        const verification = await api('/api/auth/profile/password/verify', {
          method: 'POST',
          body: { current_password: currentPassword },
        });
        const reauthToken = verification.reauth_token;
        if (!reauthToken) throw new Error('Password reauthentication token is missing');
        const response = await api('/api/auth/profile/password', {
          method: 'POST',
          body: { new_password: newPassword, reauth_token: reauthToken },
        });
        if (response.user) {
          state.user = normalizeUser(response.user);
          renderUserIdentity();
        }
        form.reset();
        toast('パスワードを変更し、ほかのセッションを無効にしました。', 'success');
      } catch (error) {
        toast(errorMessage(error, 'パスワードを変更できませんでした。'), 'error');
      }
    });
  }

  async function openRecordEditor(date) {
    const valid = validDate(date);
    if (!valid) {
      toast('日付が不正です。', 'error');
      return;
    }
    try {
      const monthValue = valid.slice(0, 7);
      const summary = await loadMonthData(monthValue, true);
      const record = summary.records.find((item) => item.work_date === valid) || normalizeRecord({}, { date: valid });
      state.editorRecord = record;
      fillRecordDialog(record);
      editorSnapshot = recordDraftSnapshot();
      byId('record-conflict').hidden = true;
      if (!byId('record-dialog').open) byId('record-dialog').showModal();
    } catch (error) {
      handleAuthenticatedError(error, '記録を開けませんでした。');
    }
  }

  function updateDefaultTimesButton() {
    const btn = byId('apply-default-times-button');
    if (!btn) return;
    const cin = userClockIn();
    const cout = userClockOut();
    if (cin && cout) {
      btn.textContent = `既定時刻を適用（${cin}–${cout}）`;
      btn.disabled = false;
    } else if (cin || cout) {
      btn.textContent = `既定時刻を適用（${cin || '--:--'}–${cout || '--:--'}）`;
      btn.disabled = false;
    } else {
      btn.textContent = '既定時刻を適用';
      btn.disabled = true;
    }
  }

  function handleApplyDefaultTimes() {
    const cin = userClockIn();
    const cout = userClockOut();
    if (cin) byId('record-clock-in').value = cin;
    if (cout) byId('record-clock-out').value = cout;
    hapticFeedback();
  }

  function fillRecordDialog(record) {
    const defaultType = record.persisted
      ? (normalizeWorkType(record.work_type) || 'office')
      : (record.is_holiday || record.day_of_week === 0 || record.day_of_week === 6 ? 'holiday' : userWorkType());
    byId('record-date').value = record.work_date;
    byId('record-date-context').textContent = `${formatJapaneseDate(record.work_date)}（${WEEKDAYS[record.day_of_week] || ''}）${record.holiday_name ? `  ${record.holiday_name}` : ''}`;
    byId('record-work-type').value = defaultType;
    byId('record-clock-in').value = record.persisted ? (record.clock_in || '') : '';
    byId('record-clock-out').value = record.persisted ? (record.clock_out || '') : '';
    updateDefaultTimesButton();
    byId('record-break').value = String(record.persisted ? record.break_minutes : userBreakMinutes());
    byId('record-one-way-fare').value = String(record.persisted ? (record.transport_one_way_fee ?? '') : (userOneWayFare() ?? ''));
    byId('record-trip-type').value = record.persisted
      ? (normalizeTripType(record.transport_trip_type) || userTripType())
      : userTripType();
    byId('record-transport-mode').value = record.persisted
      ? (normalizeTransportMode(record.transport_mode) || userTransportMode())
      : userTransportMode();
    byId('record-transport-origin').value = record.persisted
      ? record.transport_origin
      : userTransportOrigin();
    byId('record-transport-destination').value = record.persisted
      ? record.transport_destination
      : userTransportDestination();
    byId('record-memo').value = record.persisted ? record.memo : '';
    byId('delete-record-button').hidden = !record.persisted;
    byId('record-form').dataset.workType = defaultType;
    updateRecordForm();
  }

  function updateRecordForm() {
    const type = normalizeWorkType(byId('record-work-type').value) || 'office';
    const previousType = normalizeWorkType(byId('record-form').dataset.workType);
    const originalRecord = state.editorRecord;
    const working = isWorking(type);
    const office = type === 'office';
    DOM.recordWorkingFields.forEach((field) => {
      field.hidden = !working;
      field.querySelectorAll('input, select, button').forEach((el) => { el.disabled = !working; });
    });
    DOM.recordOfficeFields.forEach((field) => {
      field.hidden = !office;
      field.querySelectorAll('input, select').forEach((input) => { input.disabled = !office; });
    });
    if (!working) {
      byId('record-clock-in').value = '';
      byId('record-clock-out').value = '';
      byId('record-break').value = '0';
      byId('record-one-way-fare').value = '0';
      byId('record-transport-origin').value = '';
      byId('record-transport-destination').value = '';
    } else {
      if (previousType && !isWorking(previousType)) {
        const restoreOriginalWorkingRecord = originalRecord?.persisted && isWorking(originalRecord.work_type);
        byId('record-break').value = String(
          restoreOriginalWorkingRecord ? originalRecord.break_minutes : userBreakMinutes(),
        );
        byId('record-clock-in').value = restoreOriginalWorkingRecord
          ? (originalRecord.clock_in || '')
          : '';
        byId('record-clock-out').value = restoreOriginalWorkingRecord
          ? (originalRecord.clock_out || '')
          : '';
        updateDefaultTimesButton();
      }
      if (office && previousType && previousType !== 'office') {
        const restoreOriginalCommute = originalRecord?.persisted && originalRecord.work_type === 'office';
        byId('record-one-way-fare').value = String(
          restoreOriginalCommute ? (originalRecord.transport_one_way_fee ?? '') : (userOneWayFare() ?? ''),
        );
        byId('record-trip-type').value = restoreOriginalCommute
          ? (normalizeTripType(originalRecord.transport_trip_type) || userTripType())
          : userTripType();
        byId('record-transport-mode').value = restoreOriginalCommute
          ? (normalizeTransportMode(originalRecord.transport_mode) || userTransportMode())
          : userTransportMode();
        byId('record-transport-origin').value = restoreOriginalCommute
          ? originalRecord.transport_origin
          : userTransportOrigin();
        byId('record-transport-destination').value = restoreOriginalCommute
          ? originalRecord.transport_destination
          : userTransportDestination();
      } else if (!office) {
        byId('record-one-way-fare').value = '0';
        byId('record-transport-origin').value = '';
        byId('record-transport-destination').value = '';
      }
    }
    byId('record-form').dataset.workType = type;
    updateRecordFarePreview();
  }

  async function handleRecordSave(event) {
    event.preventDefault();
    const date = validDate(byId('record-date').value);
    const type = normalizeWorkType(byId('record-work-type').value);
    if (!date || !type) {
      toast('日付または勤務区分が不正です。', 'error');
      return;
    }
    const memo = byId('record-memo').value.slice(0, 500);
    let body;
    if (!isWorking(type)) {
      body = clearedNonWorkingRecord(type, memo);
    } else {
      const clockIn = byId('record-clock-in').value ? validTime(byId('record-clock-in').value) : null;
      const clockOut = byId('record-clock-out').value ? validTime(byId('record-clock-out').value) : null;
      if ((byId('record-clock-in').value && !clockIn) || (byId('record-clock-out').value && !clockOut)) {
        toast('時刻を HH:MM 形式で入力してください。', 'error');
        return;
      }
      let breakMinutes;
      let oneWayFare = 0;
      try {
        breakMinutes = readIntegerInput(byId('record-break'), '休憩時間', 0, 480);
        if (type === 'office') {
          oneWayFare = readIntegerInput(byId('record-one-way-fare'), '片道運賃', 0, 100000, {
            allowEmpty: true,
            emptyValue: 0,
          });
        }
      } catch (err) {
        if (err instanceof InputValidationError) {
          toast(err.message, 'error');
          return;
        }
        throw err;
      }

      body = {
        work_type: type,
        clock_in: clockIn,
        clock_out: clockOut,
        break_minutes: breakMinutes,
        transport_one_way_fee: type === 'office' ? oneWayFare : 0,
        transport_trip_type: type === 'office'
          ? (normalizeTripType(byId('record-trip-type').value) || userTripType())
          : 'one_way',
        transport_mode: type === 'office'
          ? (normalizeTransportMode(byId('record-transport-mode').value) || userTransportMode())
          : 'rail',
        transport_origin: type === 'office'
          ? commuteLocationInput(byId('record-transport-origin'))
          : '',
        transport_destination: type === 'office'
          ? commuteLocationInput(byId('record-transport-destination'))
          : '',
        memo,
      };
    }

    await withBusy(event.submitter, '保存中…', async () => {
      try {
        await api(`/api/attendance/${encodeURIComponent(date)}`, { method: 'PUT', body, headers: recordVersionHeaders() });
        closeRecordDialog(true);
        invalidateMonth(date.slice(0, 7));
        await refreshVisibleData(date);
        toast('勤務記録を保存しました。', 'success');
      } catch (error) {
        if (error.status === 412) byId('record-conflict').hidden = false;
        handleAuthenticatedError(error, '勤務記録を保存できませんでした。');
      }
    });
  }

  async function handleRecordDelete() {
    const date = validDate(byId('record-date').value);
    if (!date || !state.editorRecord?.persisted) return;
    if (!window.confirm(`${formatJapaneseDate(date)}の勤務記録を削除しますか？`)) return;
    await withBusy(byId('delete-record-button'), '削除中…', async () => {
      try {
        await api(`/api/attendance/${encodeURIComponent(date)}`, { method: 'DELETE', headers: recordVersionHeaders() });
        closeRecordDialog(true);
        invalidateMonth(date.slice(0, 7));
        await refreshVisibleData(date);
        toast('勤務記録を削除しました。', 'success');
      } catch (error) {
        if (error.status === 412) byId('record-conflict').hidden = false;
        handleAuthenticatedError(error, '勤務記録を削除できませんでした。');
      }
    });
  }

  function recordVersionHeaders(record = state.editorRecord) {
    return record?.persisted
      ? { 'If-Match': `"${record.id}:${record.revision}"` }
      : { 'If-None-Match': '*' };
  }

  function recordDraftSnapshot() {
    return JSON.stringify([
      'record-work-type', 'record-clock-in', 'record-clock-out', 'record-break',
      'record-one-way-fare', 'record-trip-type', 'record-transport-mode',
      'record-transport-origin', 'record-transport-destination', 'record-memo',
    ].map((id) => byId(id).value));
  }

  function hasUnsavedRecord() {
    return Boolean(state.editorRecord && editorSnapshot !== null && editorSnapshot !== recordDraftSnapshot());
  }

  function closeRecordDialog(force = false) {
    if (force !== true && hasUnsavedRecord() && !window.confirm('変更を保存せずに閉じますか？')) return;
    editorSnapshot = null;
    const dialog = byId('record-dialog');
    dialog?.querySelector('.dialog-toast-region')?.replaceChildren();
    if (dialog?.open) dialog.close();
    state.editorRecord = null;
  }

  function clearedNonWorkingRecord(type, memo) {
    return {
      work_type: type,
      clock_in: null,
      clock_out: null,
      break_minutes: 0,
      transport_one_way_fee: 0,
      transport_trip_type: 'one_way',
      transport_mode: 'rail',
      transport_origin: '',
      transport_destination: '',
      memo,
    };
  }

  async function refreshVisibleData(date) {
    const tasks = [];
    // The Today view is built from today's record *and* from any still-open
    // shift left on the previous day (active_record / stale_record). Repairing
    // yesterday from the stale-record notice is the only way out of a state
    // where both punch buttons are disabled, so that edit has to reload Today
    // as well or the notice and the disabled buttons survive the fix.
    const todayDate = state.today?.date || todayIso();
    if (date === todayDate || date === previousDate(todayDate)) tasks.push(loadToday());
    if (state.page === 'calendar') tasks.push(loadCalendar(true));
    if (state.page === 'summary') tasks.push(loadSummary(true));
    await Promise.all(tasks);
  }

  async function loadAdminPage() {
    await Promise.all([loadAdminUsers(), loadAdminOverview()]);
  }

  async function loadAdminUsers() {
    try {
      const raw = await api('/api/admin/users');
      const users = Array.isArray(raw.users) ? raw.users : [];
      renderAdminUsers(users.map(normalizeUser));
    } catch (error) {
      handleAuthenticatedError(error, 'ユーザー一覧を取得できませんでした。');
    }
  }

  function renderAdminUsers(users) {
    const body = byId('admin-user-list');
    body.replaceChildren();
    for (const user of users) {
      const row = document.createElement('tr');
      row.append(
        createElement('td', { text: user.display_name }),
        createElement('td', { text: user.username }),
        createElement('td', { text: user.is_admin ? '管理者' : '一般' }),
      );
      const actionCell = document.createElement('td');
      const actions = createElement('div', { className: 'button-row table-action-row' });
      const editButton = createElement('button', {
        className: 'button',
        type: 'button',
        text: '編集',
      });
      editButton.addEventListener('click', () => openAdminUserDialog(user));
      const button = createElement('button', {
        className: 'button button-danger',
        type: 'button',
        text: '削除',
      });
      button.disabled = user.id === state.user.id;
      button.addEventListener('click', () => void deleteAdminUser(user, button));
      actions.append(editButton, button);
      actionCell.append(actions);
      row.append(actionCell);
      body.append(row);
    }
  }

  function openAdminUserDialog(user) {
    state.adminEditUser = user;
    byId('admin-user-context').textContent =
      `${user.display_name || user.username}（ログイン名: ${user.username}）`;
    byId('admin-edit-name').value = user.display_name;
    byId('admin-edit-work-type').value = user.default_work_type;
    byId('admin-edit-clock-in').value = user.default_clock_in || '';
    byId('admin-edit-clock-out').value = user.default_clock_out || '';
    byId('admin-edit-break').value = String(user.default_break_minutes);
    byId('admin-edit-one-way-fare').value = user.default_one_way_fare === null
      ? ''
      : String(user.default_one_way_fare);
    byId('admin-edit-trip-type').value = user.default_trip_type;
    byId('admin-edit-transport-mode').value = user.default_transport_mode;
    byId('admin-edit-transport-origin').value = user.default_transport_origin;
    byId('admin-edit-transport-destination').value = user.default_transport_destination;
    byId('admin-edit-password').value = '';

    // Editing yourself is allowed, but not the two operations that would lock
    // you out or bypass the re-authentication the settings page enforces.
    const editingSelf = user.id === state.user?.id;
    const adminToggle = byId('admin-edit-is-admin');
    adminToggle.checked = Boolean(user.is_admin);
    adminToggle.disabled = editingSelf;
    byId('admin-edit-is-admin-help').hidden = !editingSelf;

    const resetButton = byId('admin-reset-password-button');
    const passwordInput = byId('admin-edit-password');
    resetButton.disabled = editingSelf;
    passwordInput.disabled = editingSelf;
    byId('admin-reset-password-help').textContent = editingSelf
      ? '自分のパスワードは「設定」から現在のパスワードを確認したうえで変更してください。'
      : 'リセットすると対象ユーザーの全セッションが無効になります。';

    byId('admin-user-dialog').showModal();
  }

  function closeAdminUserDialog() {
    const dialog = byId('admin-user-dialog');
    dialog?.querySelector('.dialog-toast-region')?.replaceChildren();
    if (dialog?.open) dialog.close();
    byId('admin-edit-password').value = '';
    state.adminEditUser = null;
  }

  async function handleAdminUserSave(event) {
    event.preventDefault();
    const user = state.adminEditUser;
    if (!user) return;

    const displayName = byId('admin-edit-name').value.trim();
    if (!displayName) {
      toast('氏名を入力してください。', 'error');
      return;
    }

    let breakMinutes;
    let oneWayFare;
    try {
      breakMinutes = readIntegerInput(byId('admin-edit-break'), '既定の休憩時間', 0, 480);
      oneWayFare = readIntegerInput(byId('admin-edit-one-way-fare'), '既定の片道運賃', 0, 100000, {
        allowEmpty: true,
        emptyValue: null,
      });
    } catch (err) {
      if (err instanceof InputValidationError) {
        toast(err.message, 'error');
        return;
      }
      throw err;
    }

    const body = {
      display_name: displayName,
      default_work_type: workingType(byId('admin-edit-work-type').value) || 'office',
      default_clock_in: validTime(byId('admin-edit-clock-in').value) || null,
      default_clock_out: validTime(byId('admin-edit-clock-out').value) || null,
      default_break_minutes: breakMinutes,
      default_one_way_fare: oneWayFare,
      default_trip_type: normalizeTripType(byId('admin-edit-trip-type').value) || 'round_trip',
      default_transport_mode: normalizeTransportMode(byId('admin-edit-transport-mode').value) || 'rail',
      default_transport_origin: commuteLocationInput(byId('admin-edit-transport-origin')),
      default_transport_destination: commuteLocationInput(byId('admin-edit-transport-destination')),
    };
    if (!byId('admin-edit-is-admin').disabled) {
      body.is_admin = byId('admin-edit-is-admin').checked ? 1 : 0;
    }

    await withBusy(event.submitter, '保存中…', async () => {
      try {
        const response = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body });
        const updated = normalizeUser(response.user);
        closeAdminUserDialog();
        // Editing your own row changes the defaults the punch form is built from.
        if (updated.id && updated.id === state.user?.id) {
          state.user = updated;
          renderUserIdentity();
          applyUserDefaults();
          state.monthCache.clear();
        }
        await Promise.all([loadAdminUsers(), loadAdminOverview()]);
        toast('ユーザー情報を保存しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, 'ユーザー情報を保存できませんでした。');
      }
    });
  }

  async function handleAdminPasswordReset() {
    const user = state.adminEditUser;
    if (!user) return;
    const password = byId('admin-edit-password').value;
    if (password.length < 12 || password.length > 128) {
      toast('新しいパスワードは12〜128文字にしてください。', 'error');
      return;
    }
    const label = user.display_name || user.username;
    if (!window.confirm(`${label} のパスワードをリセットしますか？\n対象ユーザーはログアウトされ、再ログインが必要になります。`)) return;

    await withBusy(byId('admin-reset-password-button'), 'リセット中…', async () => {
      try {
        await api(`/api/admin/users/${user.id}/password`, {
          method: 'POST',
          body: { new_password: password },
        });
        byId('admin-edit-password').value = '';
        toast(`${label} のパスワードをリセットしました。`, 'success');
      } catch (error) {
        handleAuthenticatedError(error, 'パスワードをリセットできませんでした。');
      }
    });
  }

  async function deleteAdminUser(user, button) {
    if (!window.confirm(`${user.display_name || user.username} を削除しますか？関連する勤怠記録も削除されます。`)) return;
    await withBusy(button, '削除中…', async () => {
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
        await Promise.all([loadAdminUsers(), loadAdminOverview()]);
        toast('ユーザーを削除しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, 'ユーザーを削除できませんでした。');
      }
    });
  }

  async function handleAdminAddUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const username = normalizeNewUsername(byId('admin-new-username').value);
    const body = {
      username: username || '',
      display_name: byId('admin-new-name').value.trim(),
      password: byId('admin-new-password').value,
      is_admin: byId('admin-new-is-admin').checked ? 1 : 0,
      default_one_way_fare: state.config.default_one_way_fare,
      default_trip_type: state.config.default_trip_type,
    };
    if (!username) {
      toast('ログイン名は3〜64文字の英数字・ドット・下線・ハイフンで入力してください。', 'error');
      return;
    }
    if (!body.display_name || body.password.length < 12 || body.password.length > 128) {
      toast('氏名と12〜128文字の初期パスワードを入力してください。', 'error');
      return;
    }
    await withBusy(event.submitter, '追加中…', async () => {
      try {
        await api('/api/admin/users', { method: 'POST', body });
        form.reset();
        await Promise.all([loadAdminUsers(), loadAdminOverview()]);
        toast('ユーザーを追加しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, 'ユーザーを追加できませんでした。');
      }
    });
  }

  let adminOverviewRequestVersion = 0;
  async function loadAdminOverview() {
    const version = ++adminOverviewRequestVersion;
    const requestedMonth = state.adminMonth;
    try {
      const [year, month] = splitMonth(requestedMonth);
      const raw = await api(`/api/admin/overview/${year}/${month}`);
      if (version !== adminOverviewRequestVersion || requestedMonth !== state.adminMonth) return;
      const users = Array.isArray(raw.users) ? raw.users : [];
      renderAdminOverview(users);
    } catch (error) {
      if (version !== adminOverviewRequestVersion) return;
      handleAuthenticatedError(error, '月次勤務概要を取得できませんでした。');
    }
  }

  function renderAdminOverview(users) {
    const body = byId('admin-overview-body');
    body.replaceChildren();
    for (const item of users) {
      const summary = unwrap(item.summary || {});
      const row = document.createElement('tr');
      // Reuses the same emphasis the personal summary table already applies to
      // a day whose punches are missing.
      const incompleteDays = numberOrZero(summary.incomplete_days);
      if (incompleteDays > 0) row.classList.add('is-incomplete-row');
      [
        safeString(item.display_name || item.username, '（名称なし）'),
        `${numberOrZero(summary.office_days)}日`,
        `${numberOrZero(summary.remote_days)}日`,
        `${numberOrZero(summary.paid_leave_days)}日`,
        `${numberOrZero(summary.absent_days)}日`,
        `${numberOrZero(summary.scheduled_work_days)}日`,
        incompleteDays > 0 ? `${incompleteDays}件` : '—',
        formatMinutes(numberOrZero(summary.total_work_minutes)),
        money(numberOrZero(summary.total_transport_fee)),
      ].forEach((value) => row.append(createElement('td', { text: value })));
      body.append(row);
    }
    if (!users.length) {
      const row = document.createElement('tr');
      const cell = createElement('td', { className: 'empty-table-cell', text: 'ユーザーがいません。' });
      cell.colSpan = 9;
      row.append(cell);
      body.append(row);
    }
  }

  async function loadMonthData(monthValue, force) {
    const valid = validMonthValue(monthValue);
    if (!valid) throw new Error('年月が不正です。');
    const cached = state.monthCache.get(valid);
    // A cached entry is either a resolved summary or an in-flight promise; both
    // are reusable when not forcing. A forced reload must never adopt a request
    // that started before the write it is meant to reflect.
    if (!force && cached && (cached.promise || Date.now() - cached.fetchedAt < MONTH_CACHE_TTL_MS)) {
      return cached.promise || cached.value;
    }
    if (force) state.monthCache.delete(valid);
    const [year, month] = splitMonth(valid);
    const loadPromise = api(`/api/attendance/${year}/${month}`)
      .then((raw) => normalizeMonthlySummary(raw, year, month));
    const entry = { promise: loadPromise };
    state.monthCache.set(valid, entry);
    try {
      const summary = await loadPromise;
      if (state.monthCache.get(valid) === entry) {
        state.monthCache.set(valid, { value: summary, fetchedAt: Date.now() });
      }
      return summary;
    } catch (error) {
      if (state.monthCache.get(valid) === entry) {
        state.monthCache.delete(valid);
      }
      throw error;
    }
  }

  function normalizeMonthlySummary(raw, year, month) {
    const source = unwrap(raw);
    const records = Array.isArray(source.records)
      ? source.records.map((record) => normalizeRecord(record)).filter((record) => record.work_date)
      : [];
    const derived = deriveSummary(records);
    return {
      year: boundedInteger(source.year, year, 1955, 2100),
      month: boundedInteger(source.month, month, 1, 12),
      username: safeString(source.username, state.user?.username || ''),
      employee_name: safeString(source.employee_name, state.user?.display_name || ''),
      office_days: finiteOr(source.office_days, derived.office_days),
      remote_days: finiteOr(source.remote_days, derived.remote_days),
      paid_leave_days: finiteOr(source.paid_leave_days, derived.paid_leave_days),
      absent_days: finiteOr(source.absent_days, derived.absent_days),
      scheduled_work_days: finiteOr(source.scheduled_work_days, derived.scheduled_work_days),
      incomplete_days: finiteOr(source.incomplete_days, derived.incomplete_days),
      total_work_minutes: finiteOr(source.total_work_minutes, derived.total_work_minutes),
      total_transport_fee: finiteOr(source.total_transport_fee, derived.total_transport_fee),
      overtime_minutes: finiteOr(source.overtime_minutes, Math.max(0, derived.total_work_minutes - state.config.overtime_threshold_hours * 60)),
      overtime_threshold_minutes: finiteOr(source.overtime_threshold_minutes, state.config.overtime_threshold_hours * 60),
      records,
      holiday_data: unwrap(source.holiday_data || {}),
    };
  }

  function normalizeRecord(raw, context) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const extra = context || {};
    const date = validDate(source.work_date || source.date || extra.date) || '';
    const type = normalizeWorkType(source.work_type);
    const trip = normalizeTripType(source.transport_trip_type);
    const totalFare = boundedInteger(source.transport_fee, 0, 0, 200000);
    const oneWayFare = boundedInteger(
      source.transport_one_way_fee,
      trip === 'round_trip' ? Math.round(totalFare / 2) : totalFare,
      0,
      100000,
    );
    const clockIn = validTime(source.clock_in);
    const clockOut = validTime(source.clock_out);
    const breakMinutes = boundedInteger(source.break_minutes, 0, 0, 480);
    const computedMinutes = clockIn && clockOut ? calculateWorkMinutes(clockIn, clockOut, breakMinutes) : null;
    return {
      id: boundedInteger(source.id, 0, 0, Number.MAX_SAFE_INTEGER),
      revision: boundedInteger(source.revision, 0, 0, Number.MAX_SAFE_INTEGER),
      work_date: date,
      work_type: type,
      clock_in: clockIn,
      clock_out: clockOut,
      break_minutes: breakMinutes,
      transport_one_way_fee: oneWayFare,
      transport_trip_type: trip,
      transport_fee: totalFare,
      transport_mode: normalizeTransportMode(source.transport_mode),
      transport_origin: safeString(source.transport_origin, '').slice(0, 120),
      transport_destination: safeString(source.transport_destination, '').slice(0, 120),
      memo: safeString(source.memo, ''),
      day_of_week: boundedInteger(source.day_of_week ?? extra.day_of_week, date ? weekdayIndex(date) : 0, 0, 6),
      is_holiday: Boolean(source.is_holiday ?? extra.is_holiday),
      holiday_name: safeString(source.holiday_name ?? extra.holiday_name, ''),
      work_minutes: nullableFinite(source.work_minutes, computedMinutes),
      persisted: isPersistedRecord(source),
    };
  }

  function deriveSummary(records) {
    const result = {
      office_days: 0,
      remote_days: 0,
      paid_leave_days: 0,
      absent_days: 0,
      scheduled_work_days: 0,
      incomplete_days: 0,
      total_work_minutes: 0,
      total_transport_fee: 0,
    };
    records.forEach((record) => {
      if (record.day_of_week !== 0 && record.day_of_week !== 6 && !record.is_holiday) result.scheduled_work_days += 1;
      if (!record.persisted) return;
      if (record.work_type === 'office') result.office_days += 1;
      if (record.work_type === 'remote') result.remote_days += 1;
      if (record.work_type === 'paid_leave') result.paid_leave_days += 1;
      if (record.work_type === 'absent') result.absent_days += 1;
      if (isWorking(record.work_type) && (!record.clock_in || !record.clock_out)) result.incomplete_days += 1;
      result.total_work_minutes += record.work_minutes || 0;
      result.total_transport_fee += record.transport_fee || 0;
    });
    return result;
  }

  function changeMonth(target, delta) {
    if (!MONTH_TARGETS.includes(target)) return;
    setMonth(target, offsetMonth(state[`${target}Month`], delta), false);
  }

  function setMonth(target, value, force) {
    if (!MONTH_TARGETS.includes(target)) return;
    if (target === 'summary' && value !== state.summaryMonth) clearExcelDownload();
    state[`${target}Month`] = value;
    renderMonthControl(target);
    if (target === 'calendar') void loadCalendar(force);
    if (target === 'summary') {
      updateExcelFilenamePreview();
      void loadSummary(force);
    }
    if (target === 'admin') void loadAdminOverview();
  }

  /**
   * The year list spans ten years back to next year, widened on demand when
   * the ‹ › buttons step outside it, so the picker stays short to scroll.
   */
  function renderMonthControl(target) {
    const yearSelect = byId(`${target}-year-select`);
    const monthSelect = byId(`${target}-month-select`);
    if (!yearSelect || !monthSelect) return;
    const [year, month] = splitMonth(state[`${target}Month`]);

    if (!Array.from(yearSelect.options).some((option) => option.value === String(year))) {
      const currentYear = Number(currentMonthValue().slice(0, 4));
      const first = Math.max(1955, Math.min(currentYear - 10, year, Number(yearSelect.options[0]?.value) || year));
      const last = Math.min(2100, Math.max(currentYear + 1, year, Number(yearSelect.options[yearSelect.options.length - 1]?.value) || year));
      const years = [];
      for (let value = first; value <= last; value += 1) years.push(new Option(`${value}年`, String(value)));
      yearSelect.replaceChildren(...years);
    }
    if (!monthSelect.options.length) {
      monthSelect.replaceChildren(...Array.from({ length: 12 }, (_, index) => (
        new Option(`${index + 1}月`, String(index + 1).padStart(2, '0'))
      )));
    }

    yearSelect.value = String(year);
    monthSelect.value = String(month).padStart(2, '0');
  }

  function invalidateMonth(monthValue) {
    state.monthCache.delete(monthValue);
    if (monthValue === state.summaryMonth) clearExcelDownload();
  }

  async function api(path, options) {
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('不正なAPIパスです。');
    const config = options || {};
    const headers = new Headers(config.headers || {});
    headers.set('Accept', 'application/json');
    let body;
    if (config.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(config.body);
    }
    let response;
    try {
      response = await fetch(path, {
        method: config.method || 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers,
        body,
      });
    } catch {
      // fetch() only rejects when the request never completed at all: offline,
      // DNS, TLS, or the server going away. The browser's own message is
      // untranslated and differs per engine ("Failed to fetch" in Chrome,
      // "Load failed" in Safari), and errorMessage() would surface it verbatim.
      // Status 0 keeps it clear of the 401 re-authentication path.
      throw new ApiError(
        'ネットワークに接続できません。通信状況を確認してからもう一度お試しください。',
        0,
        null,
      );
    }
    const contentType = response.headers.get('content-type') || '';
    let data = null;
    if (response.status !== 204) {
      if (contentType.includes('application/json')) {
        data = await response.json().catch(() => null);
      } else {
        data = await response.text().catch(() => '');
      }
    }
    if (!response.ok) {
      // Every route answers a failure with a flat `{ error: "…" }` in Japanese,
      // so that string is the message; anything else falls back to the status.
      let message = `HTTP ${response.status}`;
      if (data && typeof data === 'object') {
        message = safeString(data.error || data.message, message);
      } else {
        message = safeString(data, message);
      }
      throw new ApiError(message, response.status, data);
    }
    return data ?? {};
  }

  function handleAuthenticatedError(error, fallback) {
    if (error instanceof ApiError && error.status === 401) {
      state.user = null;
      showAuthentication(false);
      toast('セッションの有効期限が切れました。もう一度ログインしてください。', 'error');
      return;
    }
    toast(errorMessage(error, fallback), 'error');
  }

  async function withBusy(button, label, operation) {
    // Callers pass event.submitter, which is null for a programmatic submit and
    // undefined on browsers without SubmitEvent.submitter. Losing the busy
    // indicator is acceptable; silently dropping the operation is not.
    if (!button) return operation();
    if (button.disabled) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = label;
    try {
      return await operation();
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  function toast(message, kind) {
    const dialog = document.querySelector('dialog[open]');
    const region = (dialog && dialog.querySelector('.dialog-toast-region')) || byId('toast-region');
    if (!region) return;
    const item = createElement('div', { className: 'toast', text: safeString(message, 'エラーが発生しました。') });
    item.dataset.kind = kind === 'success' ? 'success' : (kind === 'error' ? 'error' : 'info');
    region.append(item);
    while (region.children.length > 3) region.firstElementChild.remove();
    window.setTimeout(() => item.remove(), 5000);
  }

  function createElement(tagName, options) {
    const element = document.createElement(tagName);
    const config = options || {};
    if (config.className) element.className = config.className;
    if (config.text !== undefined) element.textContent = safeString(config.text, '');
    if (config.type) element.type = config.type;
    if (config.ariaLabel) element.setAttribute('aria-label', config.ariaLabel);
    if (config.ariaHidden) element.setAttribute('aria-hidden', config.ariaHidden);
    return element;
  }

  function normalizeUser(raw) {
    const source = unwrap(raw);
    return {
      id: boundedInteger(source.id, 0, 0, Number.MAX_SAFE_INTEGER),
      username: safeString(source.username, ''),
      display_name: safeString(source.display_name, source.username || ''),
      is_admin: source.is_admin === true || Number(source.is_admin) === 1,
      default_one_way_fare: source.default_one_way_fare === null || source.default_one_way_fare === undefined
        ? null
        : boundedInteger(source.default_one_way_fare, state.config.default_one_way_fare, 0, 100000),
      default_trip_type: normalizeTripType(source.default_trip_type) || state.config.default_trip_type,
      default_clock_in: validTime(source.default_clock_in) || null,
      default_clock_out: validTime(source.default_clock_out) || null,
      default_break_minutes: boundedInteger(
        source.default_break_minutes,
        state.config.default_break_minutes,
        0,
        480,
      ),
      default_work_type: workingType(source.default_work_type) || 'office',
      default_transport_mode: normalizeTransportMode(source.default_transport_mode) || 'rail',
      default_transport_origin: safeString(source.default_transport_origin, '').slice(0, 120),
      default_transport_destination: safeString(source.default_transport_destination, '').slice(0, 120),
    };
  }

  function userOneWayFare() {
    return state.user?.default_one_way_fare ?? state.config.default_one_way_fare;
  }

  function userTripType() {
    return normalizeTripType(state.user?.default_trip_type) || state.config.default_trip_type;
  }

  function userClockIn() {
    return state.user?.default_clock_in || state.config.default_clock_in || '';
  }

  function userClockOut() {
    return state.user?.default_clock_out || state.config.default_clock_out || '';
  }

  function userBreakMinutes() {
    return boundedInteger(
      state.user?.default_break_minutes,
      state.config.default_break_minutes,
      0,
      480,
    );
  }

  function userWorkType() {
    return workingType(state.user?.default_work_type) || 'office';
  }

  function userTransportMode() {
    return normalizeTransportMode(state.user?.default_transport_mode) || 'rail';
  }

  function userTransportOrigin() {
    return safeString(state.user?.default_transport_origin, '').slice(0, 120);
  }

  function userTransportDestination() {
    return safeString(state.user?.default_transport_destination, '').slice(0, 120);
  }

  function normalizeWorkType(value) {
    return Object.prototype.hasOwnProperty.call(WORK_TYPES, value) ? value : null;
  }

  function workingType(value) {
    const type = normalizeWorkType(value);
    return isWorking(type) ? type : null;
  }

  function normalizeTripType(value) {
    return Object.prototype.hasOwnProperty.call(TRIP_TYPES, value) ? value : null;
  }

  function normalizeTransportMode(value) {
    return Object.prototype.hasOwnProperty.call(TRANSPORT_MODES, value) ? value : null;
  }

  function workTypeLabel(value) {
    return WORK_TYPES[value] || '不明';
  }

  function tripTypeLabel(value) {
    return TRIP_TYPES[value] || '不明';
  }

  function transportModeLabel(value) {
    return TRANSPORT_MODES[value] || '未設定';
  }

  function commuteRouteLabel(origin, destination, fallback = '未設定') {
    const from = safeString(origin, '').trim();
    const to = safeString(destination, '').trim();
    if (from && to) return `${from} → ${to}`;
    return from || to || fallback;
  }

  function isWorking(value) {
    return value === 'office' || value === 'remote';
  }

  function isScheduledDay(record) {
    return record.day_of_week !== 0 && record.day_of_week !== 6 && !record.is_holiday;
  }

  function attendanceState(record, date, today) {
    const scheduled = isScheduledDay(record);
    const persistedWorking = Boolean(record?.persisted && isWorking(record.work_type));

    const missingPunch =
      (!record?.persisted && scheduled)
      || (persistedWorking && !record.clock_in);

    const openShift =
      persistedWorking
      && record.clock_in
      && !record.clock_out;

    if (date < today) {
      if (missingPunch) return 'missing';
      if (openShift) return 'incomplete';
    }

    if (date === today) {
      if (missingPunch) return 'undecided';
      if (openShift) return 'active';
    }

    return 'normal';
  }

  function isPersistedRecord(record) {
    return Number(record.id) > 0 || Boolean(record.created_at) || Boolean(record.updated_at) ||
      Boolean(record.clock_in) || Boolean(record.clock_out) || Boolean(record.memo);
  }

  function calculateWorkMinutes(clockIn, clockOut, breakMinutes) {
    const start = timeToMinutes(clockIn);
    let end = timeToMinutes(clockOut);
    if (start === null || end === null) return 0;
    if (end < start) end += 1440;
    return Math.max(0, end - start - breakMinutes);
  }

  function timeToMinutes(value) {
    const time = validTime(value);
    if (!time) return null;
    const parts = time.split(':').map(Number);
    return parts[0] * 60 + parts[1];
  }

  function isStalePreviousDayRecord(record, today, currentTime) {
    if (
      !record?.clock_in
      || record.work_date !== previousDate(today)
    ) {
      return false;
    }
    const start = timeToMinutes(record.clock_in);
    const end = timeToMinutes(currentTime);
    return start !== null && end !== null
      && 1440 + end - start > MAX_SHIFT_MINUTES;
  }

  function validTime(value) {
    const text = String(value || '');
    const match = /^(\d{2}):(\d{2})$/.exec(text);
    return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? text : null;
  }

  function validDate(value) {
    const text = String(value || '');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1955 || year > 2100) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? text : null;
  }

  function validMonthValue(value) {
    const text = String(value || '');
    const match = /^(\d{4})-(\d{2})$/.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return year >= 1955 && year <= 2100 && month >= 1 && month <= 12 ? text : null;
  }

  function splitMonth(value) {
    const valid = validMonthValue(value) || currentMonthValue();
    return valid.split('-').map(Number);
  }

  function offsetMonth(value, delta) {
    const [year, month] = splitMonth(value);
    const date = new Date(Date.UTC(year, month - 1 + delta, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function weekdayIndex(value) {
    const date = validDate(value);
    if (!date) return 0;
    const parts = date.split('-').map(Number);
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
  }

  function previousDate(value) {
    const valid = validDate(value);
    if (!valid) return '';
    const [year, month, day] = valid.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day - 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  let _dtfFull = null;
  let _dtfFullTz = null;
  function getDateTimePartsFormatter() {
    const tz = state.config.timezone || 'Asia/Tokyo';
    if (!_dtfFull || _dtfFullTz !== tz) {
      _dtfFullTz = tz;
      _dtfFull = new Intl.DateTimeFormat('ja-JP', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
      });
    }
    return _dtfFull;
  }

  function dateTimeParts() {
    return Object.fromEntries(getDateTimePartsFormatter().formatToParts(new Date()).map((part) => [part.type, part.value]));
  }

  function todayIso() {
    const parts = dateTimeParts();
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function currentMonthValue() {
    if (!_dtfMonth) {
      _dtfMonth = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
      });
    }
    const parts = Object.fromEntries(_dtfMonth.formatToParts(new Date()).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}`;
  }

  function nowTime() {
    const parts = dateTimeParts();
    return `${parts.hour}:${parts.minute}`;
  }

  function clockActionTime() {
    const input = byId('clock-in-time');
    const manuallySelected = clockTimeEdited ? validTime(input.value) : null;
    const value = manuallySelected || nowTime();
    input.value = value;
    return value;
  }

  function resetClockActionTime() {
    byId('clock-in-time').value = nowTime();
    clockTimeEdited = false;
  }

  let resumeRequest = null;
  let lastResumeAt = 0;

  async function refreshOnResume() {
    syncClockActionTime();
    if (!state.user) return true;
    if (resumeRequest) return resumeRequest;
    if (todayIso() === lastObservedDate && Date.now() - lastResumeAt < MONTH_CACHE_TTL_MS) return true;
    resumeRequest = (async () => {
      let ok;
      if (todayIso() !== lastObservedDate) {
        ok = await handlePotentialDateRollover();
      } else {
        const results = [await loadToday(true)];
        if (state.page === 'calendar') results.push(await loadCalendar(true));
        if (state.page === 'summary') results.push(await loadSummary(true));
        if (state.page === 'admin') await loadAdminOverview();
        ok = results.every(Boolean);
      }
      if (ok) lastResumeAt = Date.now();
      return ok;
    })();
    try {
      return await resumeRequest;
    } finally {
      resumeRequest = null;
    }
  }

  function syncClockActionTime() {
    const input = byId('clock-in-time');
    // Native time pickers may commit only when dismissed. Do not reset their
    // pending selection on every tick while the control still has focus.
    if (!clockTimeEdited && document.activeElement !== input) input.value = nowTime();
  }

  let lastObservedDate = todayIso();

  async function handlePotentialDateRollover() {
    const currDate = todayIso();
    if (currDate === lastObservedDate) {
      return true;
    }
    const prevDate = lastObservedDate;
    lastObservedDate = currDate;
    if (!state.user) {
      return true;
    }

    try {
      const prevMonth = prevDate.slice(0, 7);
      const currMonth = currDate.slice(0, 7);

      state.monthCache.clear();
      resetClockActionTime();

      if (!await loadToday()) {
        lastObservedDate = prevDate;
        return false;
      }

      if (
        state.page === 'calendar'
        && (state.calendarMonth === prevMonth || state.calendarMonth === currMonth)
      ) {
        if (!await loadCalendar(true)) {
          lastObservedDate = prevDate;
          return false;
        }
      }

      if (
        state.page === 'summary'
        && (state.summaryMonth === prevMonth || state.summaryMonth === currMonth)
      ) {
        if (!await loadSummary(true)) {
          lastObservedDate = prevDate;
          return false;
        }
      }
      return true;
    } catch (error) {
      lastObservedDate = prevDate;
      handleAuthenticatedError(error, '日付変更後の記録を更新できませんでした。');
      return false;
    }
  }

  function startClock() {
    lastObservedDate = todayIso();
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      syncClockActionTime();
      const parts = dateTimeParts();
      byId('current-time').textContent = `${parts.hour}:${parts.minute}:${parts.second}`;
      const activeRecord = state.today?.active_record;
      if (
        activeRecord
        && isStalePreviousDayRecord(activeRecord, state.today.date, `${parts.hour}:${parts.minute}`)
      ) {
        state.today.active_record = null;
        state.today.stale_record = activeRecord;
        if (state.page === 'today') renderToday();
      }
      if (state.today?.record && state.page === 'today') {
        const rec = state.today.record;
        if (rec.persisted && rec.clock_in && !rec.clock_out) {
          renderTodayWorkTime(rec);
        }
      }
      const currentDate = todayIso();
      if (currentDate !== lastObservedDate) {
        void handlePotentialDateRollover();
      }
    };
    tick();
    if (state.clockTimer) window.clearInterval(state.clockTimer);
    state.clockTimer = window.setInterval(tick, 1000);
  }

  function formatJapaneseDate(value) {
    const valid = validDate(value);
    if (!valid) return '日付不明';
    const [year, month, day] = valid.split('-').map(Number);
    return `${year}年${month}月${day}日`;
  }

  let _dtfDateTime = null;
  let _dtfDateTimeTz = null;
  /**
   * SQLite datetime('now') is UTC but carries no zone suffix, and both V8 and
   * JavaScriptCore read "YYYY-MM-DD HH:MM:SS" as local time. Stamping the zone
   * on keeps the holiday sync time from rendering 9 hours early in JST.
   * Mirrors the server's parseDatabaseTimestamp.
   */
  function normalizeTimestampInput(value) {
    if (typeof value !== 'string' || value.includes('T')) return value;
    return `${value.replace(' ', 'T')}Z`;
  }

  function formatDateTime(value) {
    const date = new Date(normalizeTimestampInput(value));
    if (Number.isNaN(date.getTime())) return '';
    const tz = state.config.timezone || 'Asia/Tokyo';
    if (!_dtfDateTime || _dtfDateTimeTz !== tz) {
      _dtfDateTimeTz = tz;
      _dtfDateTime = new Intl.DateTimeFormat('ja-JP', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    }
    return _dtfDateTime.format(date);
  }

  function formatMinutes(value) {
    const minutes = Math.max(0, Math.round(Number(value) || 0));
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  }

  const JPY_FORMATTER = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' });
  function money(value) {
    const amount = Math.max(0, Math.round(Number(value) || 0));
    return JPY_FORMATTER.format(amount);
  }

  class InputValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = 'InputValidationError';
    }
  }

  function boundedInteger(value, fallback, min, max) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function readIntegerInput(input, label, min, max, { allowEmpty = false, emptyValue = null } = {}) {
    const raw = String(input?.value ?? '').trim();
    if (!raw) {
      if (allowEmpty) return emptyValue;
      throw new InputValidationError(`${label}を入力してください。`);
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new InputValidationError(`${label}は${min.toLocaleString()}〜${max.toLocaleString()}の範囲で入力してください。`);
    }
    return value;
  }

  function commuteLocationInput(input) {
    return String(input?.value || '').normalize('NFKC').trim().slice(0, 120);
  }

  function updateExcelFilenamePreview() {
    const preview = byId('excel-filename-preview');
    if (!preview) return;
    const [year, month] = splitMonth(state.summaryMonth || currentMonthValue());
    const employeeName = byId('profile-display-name')?.value.trim()
      || state.user?.display_name
      || '氏名未設定';
    preview.textContent = window.KintaiExcel?.filenameFor
      ? window.KintaiExcel.filenameFor({ year, month, employee_name: employeeName })
      : `勤怠表_${employeeName}_${year}${String(month).padStart(2, '0')}.xlsx`;
  }

  function normalizeNewUsername(value) {
    const username = String(value || '').normalize('NFKC').trim();
    return /^[A-Za-z0-9._-]{3,64}$/.test(username) ? username : null;
  }

  function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nullableFinite(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function safeString(value, fallback) {
    if (value === null || value === undefined) return String(fallback || '');
    return String(value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .slice(0, 1000);
  }

  /** Guards every response reader against a null or non-object body. */
  function unwrap(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function errorMessage(error, fallback) {
    return error instanceof Error && error.message ? safeString(error.message, fallback) : fallback;
  }

  let excelDownloadUrl = null;
  let excelDownloadVersion = 0;

  function clearExcelDownload() {
    excelDownloadVersion += 1;
    if (excelDownloadUrl) URL.revokeObjectURL(excelDownloadUrl);
    excelDownloadUrl = null;
    byId('excel-download-ready').hidden = true;
    byId('excel-download-link').removeAttribute('href');
  }

  function downloadBlob(blob, filename) {
    excelDownloadUrl = URL.createObjectURL(blob);
    const anchor = byId('excel-download-link');
    anchor.href = excelDownloadUrl;
    anchor.download = filename;
    anchor.textContent = filename;
    byId('excel-download-ready').hidden = false;
    // Slow requests can outlive transient user activation in Safari. Keep a
    // real link so another tap can save the file without fetching it again.
    if (navigator.userActivation?.isActive !== false) anchor.click();
    // Keep one URL until a new export, month change, edit or sign-out; a delayed
    // iOS download prompt must not be left pointing at an expired URL.
  }

  function systemTheme() {
    const query = systemThemeQuery || window.matchMedia('(prefers-color-scheme: light)');
    return query.matches ? 'light' : 'dark';
  }

  function effectiveTheme() {
    return document.documentElement.dataset.theme || systemTheme();
  }

  /**
   * Without a stored choice there is no data-theme at all: the stylesheet then
   * follows the system appearance by itself, before this script has run, so a
   * light-mode device never flashes the dark palette on load.
   */
  function applyStoredTheme() {
    // Reading localStorage throws outright when site data is blocked, so a
    // failed read has to leave the empty default in place rather than reassign
    // it.
    let theme = '';
    try { theme = localStorage.getItem('kintai-theme') || ''; } catch { /* storage can be unavailable */ }
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    renderThemeChrome();
  }

  function toggleTheme() {
    const theme = effectiveTheme() === 'light' ? 'dark' : 'light';
    // Choosing what the system already shows means "follow the system" again,
    // so a later appearance change (macOS / iOS Auto) is honoured.
    const followSystem = theme === systemTheme();
    if (followSystem) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (followSystem) localStorage.removeItem('kintai-theme');
      else localStorage.setItem('kintai-theme', theme);
    } catch { /* storage can be unavailable */ }
    renderThemeChrome();
  }

  let systemThemeQuery = null;
  function watchSystemTheme() {
    // Held in a variable: a MediaQueryList nothing references can be collected
    // together with its listener.
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)');
    systemThemeQuery.addEventListener?.('change', renderThemeChrome);
  }

  function renderThemeChrome() {
    byId('theme-button').textContent = effectiveTheme() === 'light' ? '☾' : '☀';
    syncThemeColor();
  }

  /**
   * From Safari 26 theme-color is only read by Home Screen / Dock web apps,
   * where it tints the status bar, so it has to follow the in-app theme and the
   * surface right under it: the header in the app, the page on the login view.
   */
  function syncThemeColor() {
    const token = byId('app-view')?.hidden === false ? '--surface' : '--bg';
    const color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (!color) return;
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute('content', color);
    });
  }

  // Start only after every module-level formatter/cache has been initialized.
  void initialize();
})();
