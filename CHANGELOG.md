# Changelog

## 2.9.1 — 2026-11-11

- Preserve unsubmitted break-duration and work-type edits when a clock-in or clock-out request fails.
- Keep the default-times button disabled in the record editor when neither personal nor application default times are configured.
- Clear cached client session state and return to the login screen when password updates hit a session conflict or expiry.
- Report control-character validation errors separately from length errors in optional string inputs, and validate non-blank setup display names consistently.
- Release stream reader locks and cancel unconsumed request and Cabinet Office holiday CSV streams when exceeding size limits.
- Consolidate duplicate user audit statements, hex encoding, holiday date helpers, monthly overview grouping (`Map.groupBy`), unused styles and redundant frontend/Excel helpers.
- Update Cloudflare Workers `compatibility_date` to `2026-11-10`, enable source maps and structured trace/log observability with query-string redaction, and read shared test configuration directly from `wrangler.jsonc` without loading `.dev.vars`.
- Update Hono, Wrangler, Cloudflare Workers types, `@cloudflare/vitest-plugin`, Vitest, ESLint and `globals`; replace superseded `undici`/`zod` overrides with `minimatch` `^11.0.7` (`npm audit`: 0 vulnerabilities).

## 2.9.0 — 2026-10-18

- Consolidate the current database schema into `migrations/001_schema.sql`.
- Preserve existing data through a verified baseline adoption step in the npm migration and deployment commands. Unknown or incomplete legacy schemas stop before changes; finish their old migrations first.
- Cover existing database upgrades, baseline adoption, repeated migrations and deletion audits with regression tests.
- Harden attendance updates, stale-edit handling and monthly record requests.
- Update the development-only `brace-expansion` dependency to 5.0.12 to resolve security advisories.
- Simplify the README and deployment instructions.

## 2.8.2 — 2026-10-01

### Safari and mobile layout

- Fix clipped month labels, including 10月, 11月 and 12月, by reserving space for the text, padding and dropdown chevron.
- Give the year/month selectors the available row width instead of leaving large empty gaps around them. Keep all month controls on one row.
- Spread the daily-details filter and actions across the available width, with larger buttons where space permits.
- Retain compact padding and single-row controls on the narrowest screens, without reducing selector text below 16px.

### Validation

- Checked all twelve month labels, alignment and overlap in Chromium at 320–1280px, and in Mac Safari 27.0.1 at narrow widths from 320–430px.
- This does not replace iPhone hardware verification. No database migration or deployment configuration changes are required.

## 2.8.1 — 2026-10-01

### Safari and mobile layout

- Keep the previous-month button, year/month selectors, next-month button and current-month button on one row in the calendar, monthly report and administration pages.
- Keep the daily-details title, incomplete-record filter, copy, print and Excel actions on one row without splitting the title.
- Use a compact Excel label on phones and the download icon on the narrowest screens while retaining the full accessible action name.
- Document the single-row layout convention in CSS comments and retain 16px year/month selector text.

### Validation

- Checked the changed layout in Mac Safari 27.0.1 at desktop and narrow widths, including 320, 375, 420 and 430px. This is not an iPhone hardware test.
- No database migration or deployment configuration changes are required by this patch.

## 2.8.0 — 2026-09-26

### Attendance reliability

- Prevent stale edits and deletions from overwriting records changed in another tab or device. Conflicts preserve the draft and offer a reload action.
- Accept multiline notes while rejecting unsupported control characters.
- Revalidate month data after a short cache lifetime and on foreground resume. Clear stale summaries on loading failures and offer a retry action.
- Keep unsubmitted punch fields during a resume refresh when the underlying record has not changed.

### Safari and mobile

- Preserve native time picker selections while the input is focused.
- Provide a reusable Excel download link after generation, including when a slow request outlives user activation.
- Improve narrow-screen month controls, summary metrics, safe areas and record editing.
- Keep complete monthly data available to report output when the screen uses the incomplete-record filter.
- Retain the year/month select controls and theme handling introduced in 2.7.0.

### Maintenance

- Remove unused session code and legacy styles; enable TypeScript unused-code checks.
- Update Hono, Cloudflare tooling, type definitions, lint tools and GitHub Actions. Keep Vitest 4.1.11 because the current Cloudflare test integration requires Vitest 4.
- Use the same password derivation cost for an unknown username as for newly stored password hashes.

### Upgrade notes

- Apply `migrations/0002_attendance_revision.sql` before deploying the Worker. `npm run deploy` applies outstanding migrations first.
- Custom attendance API clients must send `If-Match: "<id>:<revision>"` when updating or deleting an existing record, or `If-None-Match: *` when creating one. Missing preconditions return 428; stale versions return 412.
- Existing records are preserved and start at revision 1.
- The development-only Cloudflare test dependency tree still has a reported Sharp advisory; the production dependency audit is separate. Do not use `npm audit fix --force` to downgrade the test integration.
- Some observed monthly requests exceeded the Workers Free 10 ms CPU allowance. This release does not guarantee that every request remains below that allowance.
