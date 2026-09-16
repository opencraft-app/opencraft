# Profile-scoped model reset verification

## Outcome

Pass for the requested change scope. Diagnostics now resets only the selected Bot/Profile and restores its preserved system built-in model. The implementation was delivered through Gongfeng MR !4044; no instance reset, sibling Profile mutation, merge, deployment, or production operation was performed.

## Verified behavior

- Root and named Bots are eligible while sibling Bots exist, subject to running/loading/maintenance guards.
- The handler uses the selected backend `profile_id`; product `main` continues through the existing mapping to Hermes `default`.
- The selected Profile's reserved `custom` provider, default model, and usable credential are preserved and restored as primary.
- Fallbacks, other providers, model-management metadata, and credentials referenced exclusively by removed configuration are removed only from the selected Profile.
- Missing built-in state fails without writes. Save validation and credential-cleanup failures restore the original selected-Profile state.
- Current-Bot targeting and the restored-versus-removed boundary are explicit in UI copy and product documentation.

## Validation evidence

- Focused reset/helper/component Vitest: 3 files, 127 tests passed.
- Model configuration suite: 7 files, 232 tests passed.
- `pnpm check`: passed; i18n/docs/MDX checks passed and TypeScript reported 0 new diagnostics.
- `pnpm build:cn`: passed; 100 pages generated and SEO checks completed.
- Documentation validation: passed with 0 broken first-party links and 0 warnings.
- Staged change-impact validation: passed; index restored afterward.
- `git diff --check`: passed.

## Residual baseline

The full `pnpm test` command was attempted but encountered unrelated existing failures and then remained alive with open handles, so it was interrupted. Observed failures covered stale sidebar/channel assertions, missing mocks, layout/search/docs tests, and the pre-existing Indonesian renewal translation. The directly affected suites above are green; this report does not claim the repository-wide suite passed.
