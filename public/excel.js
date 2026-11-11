(function registerKintaiExcel(global) {
  'use strict';

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const WORK_TYPES = Object.freeze({
    office: '出社',
    remote: '在宅',
    paid_leave: '有給',
    holiday: '休日',
    absent: '欠勤',
  });
  const TRIP_TYPES = Object.freeze({
    one_way: '片道',
    round_trip: '往復',
  });
  const TRANSPORT_MODES = Object.freeze({
    rail: '鉄道',
    bus: 'バス',
    taxi: 'タクシー',
    other: 'その他',
  });
  const WEEKDAYS = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);

  function generateMonthlyWorkbook(input, options) {
    const summary = normalizeSummary(input, options || {});
    const attendanceSheet = buildAttendanceSheet(summary);
    const summarySheet = buildSummarySheet(summary, attendanceSheet);
    const transportSheet = buildTransportSheet(summary);
    const now = new Date();

    const files = {
      '[Content_Types].xml': contentTypesXml(),
      '_rels/.rels': rootRelationshipsXml(),
      'docProps/app.xml': appPropertiesXml(),
      'docProps/core.xml': corePropertiesXml(now),
      'xl/workbook.xml': workbookXml(
        attendanceSheet.lastRow,
        summarySheet.lastRow,
        transportSheet.lastRow,
      ),
      'xl/_rels/workbook.xml.rels': workbookRelationshipsXml(),
      'xl/styles.xml': stylesXml(),
      'xl/worksheets/sheet1.xml': attendanceSheet.xml,
      'xl/worksheets/sheet2.xml': summarySheet.xml,
      'xl/worksheets/sheet3.xml': transportSheet.xml,
    };

    return createZip(files, now);
  }

  function createWorkbookBlob(input, options) {
    return new Blob([generateMonthlyWorkbook(input, options)], { type: XLSX_MIME });
  }

  function filenameFor(input) {
    const source = unwrap(input);
    const year = integer(source.year, new Date().getFullYear(), 1955, 2100);
    const month = integer(source.month, new Date().getMonth() + 1, 1, 12);
    const employeeName = [
      source.employee_name,
      source.display_name,
      source.user?.display_name,
    ].map(filenamePart).find(Boolean) || '氏名未設定';
    return `勤怠表_${employeeName}_${year}${String(month).padStart(2, '0')}.xlsx`;
  }

  function normalizeSummary(input, options) {
    const source = unwrap(input);
    const config = unwrap(options.config || {});
    const now = new Date();
    const year = integer(source.year, now.getFullYear(), 1955, 2100);
    const month = integer(source.month, now.getMonth() + 1, 1, 12);
    const employeeName = workbookDisplayName(
      source.employee_name || source.display_name || source.user?.display_name || options.employeeName,
    );
    const thresholdMinutes = integer(
      source.overtime_threshold_minutes,
      integer(config.overtime_threshold_hours, 180, 0, 744) * 60,
      0,
      60 * 744,
    );
    const defaultOneWayFare = integer(
      source.default_one_way_fare,
      integer(config.default_one_way_fare, 0, 0, 100000),
      0,
      100000,
    );
    const defaultTripType = tripType(source.default_trip_type || config.default_trip_type) || 'round_trip';
    const defaultTransportOrigin = safeText(
      source.default_transport_origin
        ?? source.user?.default_transport_origin
        ?? config.default_transport_origin
        ?? options.defaultTransportOrigin
        ?? '',
    );
    const defaultTransportDestination = safeText(
      source.default_transport_destination
        ?? source.user?.default_transport_destination
        ?? config.default_transport_destination
        ?? options.defaultTransportDestination
        ?? '',
    );
    const defaultTransportMode = transportMode(
      source.default_transport_mode
        ?? source.user?.default_transport_mode
        ?? config.default_transport_mode
        ?? options.defaultTransportMode,
    );
    const records = normalizeRecords(source.records, year, month, {
      origin: defaultTransportOrigin,
      destination: defaultTransportDestination,
      mode: defaultTransportMode,
    });
    const derived = deriveMetrics(records);

    return {
      year,
      month,
      employeeName,
      records,
      officeDays: numberOr(source.office_days, derived.officeDays),
      remoteDays: numberOr(source.remote_days, derived.remoteDays),
      paidLeaveDays: numberOr(source.paid_leave_days, derived.paidLeaveDays),
      absentDays: numberOr(source.absent_days, derived.absentDays),
      scheduledWorkDays: numberOr(source.scheduled_work_days, derived.scheduledWorkDays),
      incompleteDays: numberOr(source.incomplete_days, derived.incompleteDays),
      totalWorkMinutes: numberOr(source.total_work_minutes, derived.totalWorkMinutes),
      totalTransportFee: numberOr(source.total_transport_fee, derived.totalTransportFee),
      overtimeMinutes: numberOr(
        source.overtime_minutes,
        Math.max(0, derived.totalWorkMinutes - thresholdMinutes),
      ),
      thresholdMinutes,
      defaultOneWayFare,
      defaultTripType,
      defaultTransportOrigin,
      defaultTransportDestination,
      defaultTransportMode,
      holidayData: unwrap(source.holiday_data || {}),
    };
  }

  function normalizeRecords(rawRecords, year, month, transportDefaults) {
    const byDate = new Map();
    if (Array.isArray(rawRecords)) {
      for (const raw of rawRecords) {
        if (!raw || typeof raw !== 'object') continue;
        const date = validDate(raw.work_date || raw.date);
        if (!date || !date.startsWith(`${year}-${String(month).padStart(2, '0')}-`)) continue;
        const dow = integer(raw.day_of_week, weekdayIndex(date), 0, 6);
        const persisted = isPersistedRecord(raw);
        const normalizedType = workType(raw.work_type);
        const normalizedTrip = tripType(raw.transport_trip_type);
        const totalFare = integer(raw.transport_fee, 0, 0, 200000);
        const oneWayFare = integer(
          raw.transport_one_way_fee,
          normalizedTrip === 'round_trip' ? Math.round(totalFare / 2) : totalFare,
          0,
          100000,
        );
        const officeRecord = persisted && normalizedType === 'office';
        const transportOrigin = officeRecord
          ? safeText(raw.transport_origin === undefined ? transportDefaults.origin : raw.transport_origin)
          : '';
        const transportDestination = officeRecord
          ? safeText(
            raw.transport_destination === undefined
              ? transportDefaults.destination
              : raw.transport_destination,
          )
          : '';
        const normalizedTransportMode = officeRecord
          ? transportMode(raw.transport_mode === undefined ? transportDefaults.mode : raw.transport_mode)
          : null;

        byDate.set(date, {
          id: integer(raw.id, 0, 0, Number.MAX_SAFE_INTEGER),
          date,
          dayOfWeek: dow,
          isHoliday: Boolean(raw.is_holiday),
          holidayName: safeText(raw.holiday_name || ''),
          persisted,
          workType: normalizedType,
          clockIn: validTime(raw.clock_in),
          clockOut: validTime(raw.clock_out),
          breakMinutes: integer(raw.break_minutes, 0, 0, 1440),
          workMinutes: normalizedWorkMinutes(raw, normalizedType),
          oneWayFare,
          tripType: normalizedTrip,
          totalFare,
          transportOrigin,
          transportDestination,
          transportMode: normalizedTransportMode,
          memo: safeText(raw.memo || ''),
        });
      }
    }

    const result = [];
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 1; day <= days; day += 1) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const existing = byDate.get(date);
      result.push(existing || {
        id: 0,
        date,
        dayOfWeek: weekdayIndex(date),
        isHoliday: false,
        holidayName: '',
        persisted: false,
        workType: null,
        clockIn: null,
        clockOut: null,
        breakMinutes: 0,
        workMinutes: null,
        oneWayFare: 0,
        tripType: null,
        totalFare: 0,
        transportOrigin: '',
        transportDestination: '',
        transportMode: null,
        memo: '',
      });
    }
    return result;
  }

  function deriveMetrics(records) {
    const totals = {
      officeDays: 0,
      remoteDays: 0,
      paidLeaveDays: 0,
      absentDays: 0,
      scheduledWorkDays: 0,
      incompleteDays: 0,
      totalWorkMinutes: 0,
      totalTransportFee: 0,
    };

    for (const record of records) {
      const scheduled = record.dayOfWeek !== 0 && record.dayOfWeek !== 6 && !record.isHoliday;
      if (scheduled) totals.scheduledWorkDays += 1;
      if (!record.persisted) continue;
      if (record.workType === 'office') totals.officeDays += 1;
      if (record.workType === 'remote') totals.remoteDays += 1;
      if (record.workType === 'paid_leave') totals.paidLeaveDays += 1;
      if (record.workType === 'absent') totals.absentDays += 1;
      if ((record.workType === 'office' || record.workType === 'remote') && (!record.clockIn || !record.clockOut)) {
        totals.incompleteDays += 1;
      }
      totals.totalWorkMinutes += record.workMinutes || 0;
      totals.totalTransportFee += record.totalFare || 0;
    }

    return totals;
  }

  function buildAttendanceSheet(summary) {
    const rows = [];
    const merges = ['A1:K1', 'A2:K2', 'A3:K3'];
    const title = `${summary.year}年${summary.month}月　勤怠一覧`;
    const identity = `氏名：${summary.employeeName || '（未設定）'}`;
    const period = `対象期間：${summary.year}/${String(summary.month).padStart(2, '0')}/01 ～ ${summary.year}/${String(summary.month).padStart(2, '0')}/${String(summary.records.length).padStart(2, '0')}　　会社月間基準：${formatDuration(summary.thresholdMinutes)}（法定時間外労働の判定ではありません）`;

    rows.push(rowXml(1, [stringCell('A1', title, 1)], 28));
    rows.push(rowXml(2, [stringCell('A2', identity, 2)], 20));
    rows.push(rowXml(3, [stringCell('A3', period, 2)], 20));
    rows.push(rowXml(4, [], 8));

    const headers = ['日付', '曜日', '勤務区分', '出勤', '退勤', '休憩（分）', '実働時間', '片道運賃', '交通区分', '交通費合計', '備考'];
    rows.push(rowXml(5, headers.map((value, index) => stringCell(`${columnName(index + 1)}5`, value, 3)), 24));

    let rowNumber = 6;
    for (const record of summary.records) {
      const sundayOrHoliday = record.isHoliday || record.dayOfWeek === 0;
      const saturday = !sundayOrHoliday && record.dayOfWeek === 6;
      const dateStyle = sundayOrHoliday ? 19 : (saturday ? 21 : 4);
      const textStyle = sundayOrHoliday ? 10 : (saturday ? 20 : 5);
      const typeLabel = record.persisted
        ? workTypeLabel(record.workType)
        : (record.isHoliday || record.dayOfWeek === 0 || record.dayOfWeek === 6 ? '休日' : '');
      const oneWay = record.persisted && record.workType === 'office' ? record.oneWayFare : null;
      const tripLabel = record.persisted && record.workType === 'office' ? tripTypeLabel(record.tripType) : '';
      const memo = [record.holidayName, record.memo]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join(' / ');
      const workCell = record.persisted && isWorking(record.workType) && record.clockIn && record.clockOut
        ? formulaCell(
          `G${rowNumber}`,
          `MAX(0,MOD(E${rowNumber}-D${rowNumber},1)-F${rowNumber}/1440)`,
          (record.workMinutes || 0) / 1440,
          6,
        )
        : blankCell(`G${rowNumber}`, 6);
      const fareCell = record.persisted && record.workType === 'office'
        ? formulaCell(
          `J${rowNumber}`,
          `H${rowNumber}*IF(I${rowNumber}="往復",2,1)`,
          record.totalFare,
          8,
        )
        : blankCell(`J${rowNumber}`, 8);
      const cells = [
        numberCell(`A${rowNumber}`, excelDateSerial(record.date), dateStyle),
        stringCell(`B${rowNumber}`, WEEKDAYS[record.dayOfWeek] || '', textStyle),
        stringCell(`C${rowNumber}`, typeLabel, textStyle),
        timeCell(`D${rowNumber}`, record.persisted ? record.clockIn : null, 6),
        timeCell(`E${rowNumber}`, record.persisted ? record.clockOut : null, 6),
        nullableNumberCell(`F${rowNumber}`, record.persisted && isWorking(record.workType) ? record.breakMinutes : null, 7),
        workCell,
        nullableNumberCell(`H${rowNumber}`, oneWay, 8),
        stringCell(`I${rowNumber}`, tripLabel, 5),
        fareCell,
        stringCell(`K${rowNumber}`, memo, 9),
      ];
      rows.push(rowXml(rowNumber, cells, 20));
      rowNumber += 1;
    }

    const totalRow = rowNumber;
    merges.push(`A${totalRow}:F${totalRow}`);
    rows.push(rowXml(totalRow, [
      stringCell(`A${totalRow}`, '合計', 11),
      formulaCell(
        `G${totalRow}`,
        `SUM(G6:G${5 + summary.records.length})`,
        summary.totalWorkMinutes / 1440,
        12,
      ),
      blankCell(`H${totalRow}`, 11),
      blankCell(`I${totalRow}`, 11),
      formulaCell(
        `J${totalRow}`,
        `SUM(J6:J${5 + summary.records.length})`,
        summary.totalTransportFee,
        13,
      ),
      blankCell(`K${totalRow}`, 11),
    ], 23));

    const signatureRow = totalRow + 2;
    const confirmationRow = totalRow + 3;
    merges.push(`B${signatureRow}:D${signatureRow}`, `G${signatureRow}:H${signatureRow}`);
    merges.push(`B${confirmationRow}:D${confirmationRow}`, `G${confirmationRow}:H${confirmationRow}`);
    rows.push(rowXml(signatureRow, [
      stringCell(`A${signatureRow}`, '申請者', 15),
      stringCell(`B${signatureRow}`, summary.employeeName, 14),
      stringCell(`F${signatureRow}`, '申請日', 15),
      blankCell(`G${signatureRow}`, 14),
    ], 24));
    rows.push(rowXml(confirmationRow, [
      stringCell(`A${confirmationRow}`, '確認者', 15),
      blankCell(`B${confirmationRow}`, 14),
      stringCell(`F${confirmationRow}`, '確認日', 15),
      blankCell(`G${confirmationRow}`, 14),
    ], 24));

    const lastRow = confirmationRow;
    const xml = worksheetXml({
      dimension: `A1:K${lastRow}`,
      columns: [12, 6, 11, 9, 9, 10, 11, 12, 10, 13, 28],
      rows,
      merges,
      freezeRows: 5,
      autoFilter: `A5:K${5 + summary.records.length}`,
      landscape: true,
      header: `&L${excelHeaderText(summary.employeeName)}&C${summary.year}年${summary.month}月 勤怠表&R&P / &N`,
      footer: '&L申請用&C社内確認用&R出力日 &D',
    });
    return {
      xml,
      lastRow,
      firstDataRow: 6,
      lastDataRow: 5 + summary.records.length,
      totalRow,
    };
  }

  function buildSummarySheet(summary, attendanceSheet) {
    const rows = [];
    const merges = ['A1:D1', 'A2:D2', 'A4:B4', 'C4:D4', 'A10:D10', 'A12:D12'];
    const title = `${summary.year}年${summary.month}月　月次サマリー`;
    const identity = `氏名：${summary.employeeName || '（未設定）'}`;
    const breakdown = transportBreakdown(summary.records);

    rows.push(rowXml(1, [stringCell('A1', title, 1)], 28));
    rows.push(rowXml(2, [stringCell('A2', identity, 2)], 20));
    rows.push(rowXml(3, [], 8));
    rows.push(rowXml(4, [
      stringCell('A4', '勤務日数', 15),
      stringCell('C4', '時間・金額', 15),
    ], 23));

    const attendanceRange = `'勤怠一覧'!$C$${attendanceSheet.firstDataRow}:$C$${attendanceSheet.lastDataRow}`;
    const metricRows = [
      ['出社日数', summary.officeDays, '総実働時間', summary.totalWorkMinutes, 'time', `COUNTIF(${attendanceRange},"出社")`, `'勤怠一覧'!$G$${attendanceSheet.totalRow}`],
      ['在宅勤務日数', summary.remoteDays, '会社月間基準', summary.thresholdMinutes, 'time', `COUNTIF(${attendanceRange},"在宅")`, null],
      ['有給休暇日数', summary.paidLeaveDays, '会社基準超過', summary.overtimeMinutes, 'time', `COUNTIF(${attendanceRange},"有給")`, 'MAX(0,D5-D6)'],
      ['欠勤日数', summary.absentDays, '交通費合計', summary.totalTransportFee, 'currency', `COUNTIF(${attendanceRange},"欠勤")`, `'勤怠一覧'!$J$${attendanceSheet.totalRow}`],
      ['所定勤務日数', summary.scheduledWorkDays, '不完全な記録', summary.incompleteDays, 'integer', null, null],
    ];
    metricRows.forEach((metric, index) => {
      const row = 5 + index;
      rows.push(rowXml(row, [
        stringCell(`A${row}`, metric[0], 9),
        metric[5]
          ? formulaCell(`B${row}`, metric[5], metric[1], 16)
          : numberCell(`B${row}`, metric[1], 16),
        stringCell(`C${row}`, metric[2], 9),
        metric[6]
          ? formulaCell(
            `D${row}`,
            metric[6],
            metric[4] === 'time' ? metric[3] / 1440 : metric[3],
            metric[4] === 'time' ? 17 : (metric[4] === 'currency' ? 18 : 16),
          )
          : (metric[4] === 'time'
            ? durationCell(`D${row}`, metric[3], 17)
            : numberCell(`D${row}`, metric[3], metric[4] === 'currency' ? 18 : 16)),
      ], 22));
    });

    rows.push(rowXml(10, [
      stringCell('A10', '※ 会社基準超過は社内集計用であり、労働基準法上の時間外労働を判定するものではありません。', 2),
    ], 28));
    rows.push(rowXml(11, [
      stringCell('A11', '既定の片道運賃', 9),
      numberCell('B11', summary.defaultOneWayFare, 8),
      stringCell('C11', '既定の交通区分', 9),
      stringCell('D11', tripTypeLabel(summary.defaultTripType), 5),
    ], 22));
    rows.push(rowXml(12, [stringCell('A12', '交通費内訳', 15)], 23));
    rows.push(rowXml(13, ['交通区分', '件数', '片道運賃合計', '支給額'].map((value, index) => (
      stringCell(`${columnName(index + 1)}13`, value, 3)
    )), 23));
    rows.push(rowXml(14, [
      stringCell('A14', '往復', 5),
      formulaCell('B14', `COUNTIF('勤怠一覧'!$I$${attendanceSheet.firstDataRow}:$I$${attendanceSheet.lastDataRow},"往復")`, breakdown.roundTrip.count, 7),
      formulaCell('C14', `SUMIF('勤怠一覧'!$I$${attendanceSheet.firstDataRow}:$I$${attendanceSheet.lastDataRow},"往復",'勤怠一覧'!$H$${attendanceSheet.firstDataRow}:$H$${attendanceSheet.lastDataRow})`, breakdown.roundTrip.oneWayTotal, 8),
      formulaCell('D14', `SUMIF('勤怠一覧'!$I$${attendanceSheet.firstDataRow}:$I$${attendanceSheet.lastDataRow},"往復",'勤怠一覧'!$J$${attendanceSheet.firstDataRow}:$J$${attendanceSheet.lastDataRow})`, breakdown.roundTrip.total, 8),
    ], 21));
    rows.push(rowXml(15, [
      stringCell('A15', '片道', 5),
      formulaCell('B15', `COUNTIF('勤怠一覧'!$I$${attendanceSheet.firstDataRow}:$I$${attendanceSheet.lastDataRow},"片道")`, breakdown.oneWay.count, 7),
      formulaCell('C15', `SUMIF('勤怠一覧'!$I$${attendanceSheet.firstDataRow}:$I$${attendanceSheet.lastDataRow},"片道",'勤怠一覧'!$H$${attendanceSheet.firstDataRow}:$H$${attendanceSheet.lastDataRow})`, breakdown.oneWay.oneWayTotal, 8),
      formulaCell('D15', `SUMIF('勤怠一覧'!$I$${attendanceSheet.firstDataRow}:$I$${attendanceSheet.lastDataRow},"片道",'勤怠一覧'!$J$${attendanceSheet.firstDataRow}:$J$${attendanceSheet.lastDataRow})`, breakdown.oneWay.total, 8),
    ], 21));
    rows.push(rowXml(16, [
      stringCell('A16', '合計', 11),
      formulaCell('B16', 'SUM(B14:B15)', breakdown.roundTrip.count + breakdown.oneWay.count, 11),
      formulaCell('C16', 'SUM(C14:C15)', breakdown.roundTrip.oneWayTotal + breakdown.oneWay.oneWayTotal, 13),
      formulaCell('D16', `'勤怠一覧'!$J$${attendanceSheet.totalRow}`, summary.totalTransportFee, 13),
    ], 23));

    const signatureRow = 18;
    const confirmationRow = 19;
    merges.push(`B${signatureRow}:D${signatureRow}`, `B${confirmationRow}:D${confirmationRow}`);
    rows.push(rowXml(signatureRow, [
      stringCell(`A${signatureRow}`, '申請者・申請日', 15),
      stringCell(`B${signatureRow}`, summary.employeeName, 14),
    ], 24));
    rows.push(rowXml(confirmationRow, [
      stringCell(`A${confirmationRow}`, '確認者・確認日', 15),
      blankCell(`B${confirmationRow}`, 14),
    ], 24));

    const lastRow = confirmationRow;
    const xml = worksheetXml({
      dimension: `A1:D${lastRow}`,
      columns: [25, 18, 25, 18],
      rows,
      merges,
      freezeRows: 3,
      autoFilter: 'A13:D15',
      landscape: false,
      header: `&L${excelHeaderText(summary.employeeName)}&C月次サマリー&R&P / &N`,
      footer: '&L申請用&C社内確認用&R出力日 &D',
    });
    return { xml, lastRow };
  }

  function buildTransportSheet(summary) {
    const rows = [];
    const merges = ['A1:I1', 'A2:I2', 'A3:I3'];
    const title = `${summary.year}年${summary.month}月　交通費明細`;
    const identity = `氏名：${summary.employeeName || '（未設定）'}`;
    const period = `対象期間：${summary.year}/${String(summary.month).padStart(2, '0')}/01 ～ ${summary.year}/${String(summary.month).padStart(2, '0')}/${String(summary.records.length).padStart(2, '0')}`;
    const officeRecords = summary.records.filter((record) => (
      record.persisted && record.workType === 'office'
    ));

    rows.push(rowXml(1, [stringCell('A1', title, 1)], 28));
    rows.push(rowXml(2, [stringCell('A2', identity, 2)], 20));
    rows.push(rowXml(3, [stringCell('A3', period, 2)], 20));
    const headers = ['利用日', '曜日', '出発地', '到着地', '交通手段', '利用区分', '片道運賃', '支給額', '備考'];
    rows.push(rowXml(4, headers.map((value, index) => (
      stringCell(`${columnName(index + 1)}4`, value, 3)
    )), 24));

    let rowNumber = 5;
    for (const record of officeRecords) {
      const sundayOrHoliday = record.isHoliday || record.dayOfWeek === 0;
      const saturday = !sundayOrHoliday && record.dayOfWeek === 6;
      const dateStyle = sundayOrHoliday ? 19 : (saturday ? 21 : 4);
      const textStyle = sundayOrHoliday ? 10 : (saturday ? 20 : 5);
      const tripLabel = tripTypeLabel(record.tripType);
      const memo = [record.holidayName, record.memo]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join(' / ');
      rows.push(rowXml(rowNumber, [
        numberCell(`A${rowNumber}`, excelDateSerial(record.date), dateStyle),
        stringCell(`B${rowNumber}`, WEEKDAYS[record.dayOfWeek] || '', textStyle),
        stringCell(`C${rowNumber}`, record.transportOrigin, 9),
        stringCell(`D${rowNumber}`, record.transportDestination, 9),
        stringCell(
          `E${rowNumber}`,
          record.transportMode ? transportModeLabel(record.transportMode) : '',
          5,
        ),
        stringCell(`F${rowNumber}`, tripLabel, 5),
        numberCell(`G${rowNumber}`, record.oneWayFare, 8),
        formulaCell(
          `H${rowNumber}`,
          `G${rowNumber}*IF(F${rowNumber}="往復",2,1)`,
          record.totalFare,
          8,
        ),
        stringCell(`I${rowNumber}`, memo, 9),
      ], 22));
      rowNumber += 1;
    }

    const totalRow = rowNumber;
    merges.push(`A${totalRow}:G${totalRow}`);
    rows.push(rowXml(totalRow, [
      stringCell(`A${totalRow}`, '交通費合計', 11),
      formulaCell(
        `H${totalRow}`,
        officeRecords.length ? `SUM(H5:H${totalRow - 1})` : '0',
        summary.totalTransportFee,
        13,
      ),
      blankCell(`I${totalRow}`, 11),
    ], 23));

    const lastRow = totalRow;
    const lastDataRow = officeRecords.length ? totalRow - 1 : 4;
    const xml = worksheetXml({
      dimension: `A1:I${lastRow}`,
      columns: [12, 6, 18, 18, 12, 10, 12, 13, 24],
      rows,
      merges,
      freezeRows: 4,
      autoFilter: `A4:I${lastDataRow}`,
      landscape: true,
      header: `&L${excelHeaderText(summary.employeeName)}&C${summary.year}年${summary.month}月 交通費明細&R&P / &N`,
      footer: '&L申請用&C社内確認用&R出力日 &D',
    });
    return { xml, lastRow };
  }

  function worksheetXml(options) {
    const columns = options.columns.map((width, index) => (
      `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
    )).join('');
    const mergeXml = options.merges.length
      ? `<mergeCells count="${options.merges.length}">${options.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
      : '';
    const autoFilter = options.autoFilter ? `<autoFilter ref="${options.autoFilter}"/>` : '';
    const pane = options.freezeRows
      ? `<pane ySplit="${options.freezeRows}" topLeftCell="A${options.freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${options.freezeRows + 1}" sqref="A${options.freezeRows + 1}"/>`
      : '<selection activeCell="A1" sqref="A1"/>';
    const orientation = options.landscape ? 'landscape' : 'portrait';

    return xmlDocument(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<dimension ref="${options.dimension}"/>` +
        `<sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews>` +
        `<sheetFormatPr defaultRowHeight="18"/>` +
        `<cols>${columns}</cols>` +
        `<sheetData>${options.rows.join('')}</sheetData>` +
        `${autoFilter}${mergeXml}` +
        `<printOptions horizontalCentered="1" verticalCentered="0"/>` +
        `<pageMargins left="0.25" right="0.25" top="0.55" bottom="0.55" header="0.2" footer="0.2"/>` +
        `<pageSetup paperSize="9" orientation="${orientation}" fitToWidth="1" fitToHeight="0"/>` +
        `<headerFooter><oddHeader>${xmlEscape(options.header)}</oddHeader><oddFooter>${xmlEscape(options.footer)}</oddFooter></headerFooter>` +
      `</worksheet>`,
    );
  }

  function workbookXml(attendanceLastRow, summaryLastRow, transportLastRow) {
    return xmlDocument(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<fileVersion appName="Kintai"/>` +
        `<workbookPr date1904="0"/>` +
        `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="22000" windowHeight="12500"/></bookViews>` +
        `<sheets>` +
          `<sheet name="勤怠一覧" sheetId="1" r:id="rId1"/>` +
          `<sheet name="月次サマリー" sheetId="2" r:id="rId2"/>` +
          `<sheet name="交通費明細" sheetId="3" r:id="rId3"/>` +
        `</sheets>` +
        `<definedNames>` +
          `<definedName name="_xlnm.Print_Titles" localSheetId="0">'勤怠一覧'!$1:$5</definedName>` +
          `<definedName name="_xlnm.Print_Area" localSheetId="0">'勤怠一覧'!$A$1:$K$${attendanceLastRow}</definedName>` +
          `<definedName name="_xlnm.Print_Titles" localSheetId="1">'月次サマリー'!$1:$4</definedName>` +
          `<definedName name="_xlnm.Print_Area" localSheetId="1">'月次サマリー'!$A$1:$D$${summaryLastRow}</definedName>` +
          `<definedName name="_xlnm.Print_Titles" localSheetId="2">'交通費明細'!$1:$4</definedName>` +
          `<definedName name="_xlnm.Print_Area" localSheetId="2">'交通費明細'!$A$1:$I$${transportLastRow}</definedName>` +
        `</definedNames>` +
        `<calcPr calcId="191029" fullCalcOnLoad="1"/>` +
      `</workbook>`,
    );
  }

  function workbookRelationshipsXml() {
    return xmlDocument(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>` +
        `<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
    );
  }

  function rootRelationshipsXml() {
    return xmlDocument(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
        `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
    );
  }

  function contentTypesXml() {
    return xmlDocument(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
        `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`,
    );
  }

  function corePropertiesXml(date) {
    const iso = date.toISOString();
    return xmlDocument(
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>勤怠表</dc:title><dc:subject>月次勤怠</dc:subject><dc:creator>勤怠表</dc:creator>` +
        `<cp:lastModifiedBy>勤怠表</cp:lastModifiedBy>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
      `</cp:coreProperties>`,
    );
  }

  function appPropertiesXml() {
    return xmlDocument(
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
        `<Application>勤怠表</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>` +
        `<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>ワークシート</vt:lpstr></vt:variant><vt:variant><vt:i4>3</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
        `<TitlesOfParts><vt:vector size="3" baseType="lpstr"><vt:lpstr>勤怠一覧</vt:lpstr><vt:lpstr>月次サマリー</vt:lpstr><vt:lpstr>交通費明細</vt:lpstr></vt:vector></TitlesOfParts>` +
        `<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion>` +
      `</Properties>`,
    );
  }

  function stylesXml() {
    const border = `<border><left style="thin"><color rgb="FFD7DEE3"/></left><right style="thin"><color rgb="FFD7DEE3"/></right><top style="thin"><color rgb="FFD7DEE3"/></top><bottom style="thin"><color rgb="FFD7DEE3"/></bottom><diagonal/></border>`;
    const xf = (numFmtId, fontId, fillId, borderId, alignment, extra) => (
      `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="${borderId ? 1 : 0}" applyNumberFormat="${numFmtId ? 1 : 0}"${extra || ''}>${alignment ? `<alignment ${alignment}/>` : ''}</xf>`
    );
    const cellXfs = [
      xf(0, 0, 0, 0, '', ''),
      xf(0, 1, 2, 0, 'horizontal="center" vertical="center"', ''),
      xf(0, 5, 0, 0, 'horizontal="left" vertical="center"', ''),
      xf(0, 2, 3, 1, 'horizontal="center" vertical="center" wrapText="1"', ''),
      xf(164, 0, 0, 1, 'horizontal="center" vertical="center"', ''),
      xf(0, 0, 0, 1, 'horizontal="center" vertical="center"', ''),
      xf(165, 0, 0, 1, 'horizontal="center" vertical="center"', ''),
      xf(1, 0, 0, 1, 'horizontal="center" vertical="center"', ''),
      xf(166, 0, 0, 1, 'horizontal="right" vertical="center"', ''),
      xf(0, 0, 0, 1, 'horizontal="left" vertical="center" wrapText="1"', ''),
      xf(0, 4, 4, 1, 'horizontal="center" vertical="center"', ''),
      xf(0, 3, 6, 1, 'horizontal="center" vertical="center"', ''),
      xf(165, 3, 6, 1, 'horizontal="right" vertical="center"', ''),
      xf(166, 3, 6, 1, 'horizontal="right" vertical="center"', ''),
      xf(0, 0, 5, 1, 'horizontal="left" vertical="center"', ''),
      xf(0, 2, 2, 1, 'horizontal="center" vertical="center"', ''),
      xf(1, 3, 0, 1, 'horizontal="right" vertical="center"', ''),
      xf(165, 3, 0, 1, 'horizontal="right" vertical="center"', ''),
      xf(166, 3, 0, 1, 'horizontal="right" vertical="center"', ''),
      xf(164, 4, 4, 1, 'horizontal="center" vertical="center"', ''),
      xf(0, 6, 7, 1, 'horizontal="center" vertical="center"', ''),
      xf(164, 6, 7, 1, 'horizontal="center" vertical="center"', ''),
    ].join('');

    return xmlDocument(
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<numFmts count="3">` +
          `<numFmt numFmtId="164" formatCode="yyyy/m/d"/>` +
          `<numFmt numFmtId="165" formatCode="[h]:mm"/>` +
          `<numFmt numFmtId="166" formatCode="[$¥-411]#,##0;[Red]-[$¥-411]#,##0"/>` +
        `</numFmts>` +
        `<fonts count="7">` +
          `<font><sz val="10"/><name val="Yu Gothic"/><family val="2"/></font>` +
          `<font><b/><sz val="17"/><color rgb="FFFFFFFF"/><name val="Yu Gothic"/><family val="2"/></font>` +
          `<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Yu Gothic"/><family val="2"/></font>` +
          `<font><b/><sz val="10"/><name val="Yu Gothic"/><family val="2"/></font>` +
          `<font><b/><sz val="10"/><color rgb="FFB42323"/><name val="Yu Gothic"/><family val="2"/></font>` +
          `<font><i/><sz val="9"/><color rgb="FF64727D"/><name val="Yu Gothic"/><family val="2"/></font>` +
          `<font><sz val="10"/><color rgb="FF1D4ED8"/><name val="Yu Gothic"/><family val="2"/></font>` +
        `</fonts>` +
        `<fills count="8">` +
          `<fill><patternFill patternType="none"/></fill>` +
          `<fill><patternFill patternType="gray125"/></fill>` +
          `<fill><patternFill patternType="solid"><fgColor rgb="FF24313D"/><bgColor indexed="64"/></patternFill></fill>` +
          `<fill><patternFill patternType="solid"><fgColor rgb="FFA97716"/><bgColor indexed="64"/></patternFill></fill>` +
          `<fill><patternFill patternType="solid"><fgColor rgb="FFFDECEC"/><bgColor indexed="64"/></patternFill></fill>` +
          `<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4CC"/><bgColor indexed="64"/></patternFill></fill>` +
          `<fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F3"/><bgColor indexed="64"/></patternFill></fill>` +
          `<fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/><bgColor indexed="64"/></patternFill></fill>` +
        `</fills>` +
        `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${border}</borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="22">${cellXfs}</cellXfs>` +
        `<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles>` +
        `<dxfs count="0"/>` +
        `<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>` +
      `</styleSheet>`,
    );
  }

  function rowXml(row, cells, height) {
    return `<row r="${row}" ht="${height}" customHeight="1">${cells.join('')}</row>`;
  }

  function stringCell(ref, value, style) {
    const text = safeText(value);
    if (!text) return blankCell(ref, style);
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
  }

  function numberCell(ref, value, style) {
    const number = Number(value);
    return Number.isFinite(number)
      ? `<c r="${ref}" s="${style}"><v>${number}</v></c>`
      : blankCell(ref, style);
  }

  function formulaCell(ref, formula, cachedValue, style) {
    const number = Number(cachedValue);
    if (!Number.isFinite(number)) return blankCell(ref, style);
    return `<c r="${ref}" s="${style}"><f>${xmlEscape(formula)}</f><v>${number}</v></c>`;
  }

  function nullableNumberCell(ref, value, style) {
    return value === null || value === undefined ? blankCell(ref, style) : numberCell(ref, value, style);
  }

  function timeCell(ref, value, style) {
    const time = validTime(value);
    if (!time) return blankCell(ref, style);
    const parts = time.split(':').map(Number);
    return numberCell(ref, (parts[0] * 60 + parts[1]) / 1440, style);
  }

  function durationCell(ref, minutes, style) {
    const value = nullableInteger(minutes, 0, 1440 * 400);
    return value === null ? blankCell(ref, style) : numberCell(ref, value / 1440, style);
  }

  function blankCell(ref, style) {
    return `<c r="${ref}" s="${style}"/>`;
  }

  function transportBreakdown(records) {
    const result = {
      roundTrip: { count: 0, oneWayTotal: 0, total: 0 },
      oneWay: { count: 0, oneWayTotal: 0, total: 0 },
    };
    for (const record of records) {
      if (!record.persisted || record.workType !== 'office' || !record.tripType) continue;
      const bucket = record.tripType === 'round_trip' ? result.roundTrip : result.oneWay;
      bucket.count += 1;
      bucket.oneWayTotal += record.oneWayFare;
      bucket.total += record.totalFare;
    }
    return result;
  }

  function workTypeLabel(value) {
    return WORK_TYPES[value] || '不明';
  }

  function tripTypeLabel(value) {
    return TRIP_TYPES[value] || '不明';
  }

  function workType(value) {
    return Object.prototype.hasOwnProperty.call(WORK_TYPES, value) ? value : null;
  }

  function tripType(value) {
    return Object.prototype.hasOwnProperty.call(TRIP_TYPES, value) ? value : null;
  }

  function transportModeLabel(value) {
    return TRANSPORT_MODES[value] || '不明';
  }

  function transportMode(value) {
    return Object.prototype.hasOwnProperty.call(TRANSPORT_MODES, value) ? value : null;
  }

  function isWorking(value) {
    return value === 'office' || value === 'remote';
  }

  function normalizedWorkMinutes(record, normalizedType) {
    const provided = nullableInteger(record.work_minutes, 0, 1440 * 2);
    if (provided !== null) return provided;
    if (!isWorking(normalizedType)) return null;
    const clockIn = validTime(record.clock_in);
    const clockOut = validTime(record.clock_out);
    if (!clockIn || !clockOut) return null;
    const [inHour, inMinute] = clockIn.split(':').map(Number);
    const [outHour, outMinute] = clockOut.split(':').map(Number);
    const start = inHour * 60 + inMinute;
    let end = outHour * 60 + outMinute;
    if (end < start) end += 1440;
    const breakMinutes = integer(record.break_minutes, 0, 0, 1440);
    return Math.max(0, end - start - breakMinutes);
  }

  function isPersistedRecord(record) {
    return Number(record.id) > 0 || Boolean(record.created_at) || Boolean(record.updated_at) ||
      Boolean(record.clock_in) || Boolean(record.clock_out) || Boolean(record.memo);
  }

  function unwrap(value) {
    if (!value || typeof value !== 'object') return {};
    if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) return value.data;
    return value;
  }

  function safeText(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
      .slice(0, 1000);
  }

  function excelHeaderText(value) {
    return safeText(value).replace(/[\r\n]+/g, ' ').replace(/&/g, '&&');
  }

  function xmlEscape(value) {
    return safeText(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function filenamePart(value) {
    const safe = String(value === null || value === undefined ? '' : value)
      .normalize('NFC')
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
      .replace(/\p{Cf}/gu, ' ')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/gu, ' ')
      .replace(/_+/g, '_')
      .replace(/\s*_\s*/g, '_')
      .replace(/^[._\s]+|[._\s]+$/gu, '');
    return truncateUtf8(safe, 120).replace(/^[._\s]+|[._\s]+$/gu, '');
  }

  function workbookDisplayName(value) {
    return safeText(value)
      .normalize('NFC')
      .replace(/\p{Cf}/gu, '')
      .trim()
      .slice(0, 80);
  }

  function truncateUtf8(value, maxBytes) {
    const encoder = new TextEncoder();
    let bytes = 0;
    let result = '';
    for (const character of value) {
      const characterBytes = encoder.encode(character).length;
      if (bytes + characterBytes > maxBytes) break;
      result += character;
      bytes += characterBytes;
    }
    return result;
  }

  function validDate(value) {
    const text = String(value || '');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? text
      : null;
  }

  function validTime(value) {
    const text = String(value || '');
    const match = /^(\d{2}):(\d{2})$/.exec(text);
    if (!match) return null;
    return Number(match[1]) < 24 && Number(match[2]) < 60 ? text : null;
  }

  function weekdayIndex(date) {
    const parts = date.split('-').map(Number);
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
  }

  function excelDateSerial(date) {
    const parts = date.split('-').map(Number);
    return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000) + 25569;
  }

  function formatDuration(minutes) {
    const safe = Math.max(0, Number(minutes) || 0);
    return `${Math.floor(safe / 60)}時間${String(Math.floor(safe % 60)).padStart(2, '0')}分`;
  }

  function integer(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function nullableInteger(value, min, max) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function columnName(index) {
    let value = index;
    let result = '';
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(65 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }

  function xmlDocument(body) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) {
      crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function createZip(files, date) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    const timestamps = dosDateTime(date);
    let offset = 0;
    let count = 0;

    for (const [name, raw] of Object.entries(files)) {
      const nameBytes = encoder.encode(name);
      const data = raw instanceof Uint8Array ? raw : encoder.encode(String(raw));
      const checksum = crc32(data);
      const localHeader = concatBytes([
        u32(0x04034B50), u16(20), u16(0x0800), u16(0),
        u16(timestamps.time), u16(timestamps.date), u32(checksum),
        u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
        nameBytes,
      ]);
      localParts.push(localHeader, data);

      const centralHeader = concatBytes([
        u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(0),
        u16(timestamps.time), u16(timestamps.date), u32(checksum),
        u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
        u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
      ]);
      centralParts.push(centralHeader);
      offset += localHeader.length + data.length;
      count += 1;
    }

    const localData = concatBytes(localParts);
    const centralData = concatBytes(centralParts);
    const end = concatBytes([
      u32(0x06054B50), u16(0), u16(0), u16(count), u16(count),
      u32(centralData.length), u32(localData.length), u16(0),
    ]);
    return concatBytes([localData, centralData, end]);
  }

  function dosDateTime(date) {
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    return {
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    };
  }

  function u16(value) {
    return Uint8Array.of(value & 0xFF, (value >>> 8) & 0xFF);
  }

  function u32(value) {
    return Uint8Array.of(
      value & 0xFF,
      (value >>> 8) & 0xFF,
      (value >>> 16) & 0xFF,
      (value >>> 24) & 0xFF,
    );
  }

  function concatBytes(parts) {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  const api = Object.freeze({
    XLSX_MIME,
    generateMonthlyWorkbook,
    createWorkbookBlob,
    filenameFor,
  });

  global.KintaiExcel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
