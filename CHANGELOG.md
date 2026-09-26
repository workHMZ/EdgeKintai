# Changelog

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
