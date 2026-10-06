---
id: opencraft-tencentoa-20261006
type: task
scope: Optional Tencent OA employee identity recognition for headless OpenCraft.
triggers: ["tencentoa", "TAI employee identity", "TOF login recognition"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/plugins/tencentoa/
  - opencraft/scripts/headless-server.mjs
status: active
reviewed_at: 2026-10-06
review_due: 2026-11-06
revision: 1.0.0
precedence: task
derived: false
---

## goal
Add an optional tencentoa plugin that recognizes the current visitor from verified TAI request identity and exposes an employee-identity settings page and authentication provider.

## non_goals
- No deployment, restart, production change or real credential persistence.
- User subsequently authorized commit, push and integration into master; only Tencent OA source and its records are in scope.
- No replacement of LightVela account, logout impersonation, multi-tenant resource authorization, or change to anonymous workspace access.
- No identity passed into model prompts, Thread records, generic logs or durable client storage.

## requirement_refs / requirement_excerpt
- requirement_ids: TENCENTOA-EMPLOYEE-IDENTITY
- User: “新增tencentoa 插件 识别员工登录身份”.
- User supplied TAI signing specification: SHA256 of timestamp + application token + sequence/staff fields + timestamp; uppercase hex; 180-second clock tolerance.
- User supplied TOF Go example: compact JWE, direct application-token key, A256GCM, expiration in RFC3339 with three-minute grace.
- Original sources https://iwiki.woa.com/p/1784517419 and https://iwiki.woa.com/p/4007728669 are inaccessible from this host; rely on user-provided contents, not presumed live document access.

## interface_refs / data_structure_refs
- `opencraft/packages/workbench-runtime/src/authentication/contract.ts`
- `opencraft/packages/extension-react/src/index.ts`
- `opencraft/scripts/serve-workbench-web.mjs`
- Request verification is server-owned and request-scoped; the browser receives only a minimal identity projection. Credentials and identity ciphertext never cross the response boundary.
- Exact/ASCII-case-insensitive known identity fields normalize once; ambiguous aliases fail closed. Identity is not shared installation authority.

## history_context
- current_design_refs: `opencraft/docs/platform-architecture.md#authentication-ownership`, `opencraft/docs/plugin-architecture.md`.
- relevant_evolution: baseline 3cefebe3e; live read-only diagnostic verified signature, authenticated JWE decryption and expiry for three requests. Actual fields: LoginName, StaffId, Expiration, open_id. No plaintext identity recorded.
- superseded_refs: mobile-only assumption that identity always arrives as STAFFNAME.

## acceptance
- Correct request yields current employee projection, no ciphertext/open_id/secret.
- Missing, duplicate, tampered, expired, wrong-key or unsupported-algorithm input cannot authenticate.
- No global visitor cache; successive users remain isolated.
- Browser late responses, cancellation, expiry and plugin disposal cannot resurrect retired identity.
- Existing settings primitives and AuthenticationService integration; LightVela footer remains unchanged.
- Plugin and Web typecheck, focused tests, boundary checks, real browser settings acceptance, relevant headless regression tests.

## affected_paths
- `opencraft/plugins/tencentoa/`
- `opencraft/scripts/headless-server.mjs`
- `opencraft/scripts/serve-workbench-web.mjs`
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`
- Workspace package declarations, lockfile, focused tests and architecture documentation.

## required_context / context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Repository rules | No secrets, no implied deployment; isolated worktree |
| `docs/context/project/services/frontend.md` | Router must_read | No mono2 frontend behavior change |
| `docs/context/domains/identity-access.md` | Identity boundary | No self-asserted browser identity |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Maintenance trigger | Ownership and lifecycle first |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Verification | Runtime + real component acceptance |
| `opencraft/docs/platform-architecture.md` authentication section | Current authentication broker | Provider-owned truth, no credential crossing |
| `opencraft/docs/plugin-architecture.md` | Extension topology | Optional activation and disposal |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Adjacent contract | Inspect existing authentication tests and i18n checker |

## evidence
- Running preview is independent of this worktree; no live modifications.
- Source base 3cefebe3e is clean; implementation uses a new isolated worktree.

## risks / decisions
- TAI external authentication cannot prove ownership of OpenCraft installation resources. Recognition does not grant SSH/desktop/Thread authority.
- Request signatures do not cover the JWE field; JWE authentication tag and strict algorithm selection provide its integrity separately. No per-request replay rejection without a defined proxy retry contract.
- Credentials are supplied by an operator-selected private file, not browser settings or model credentials; optional integration is disabled by default.
- Settings page is separate because the existing platform-account contribution is a singleton owned by LightVela. Do not relax that invariant for this task.

## validation
- Tencent OA focused tests: 11/11 passed, including real HTTP and ExtensionSupervisor boundaries.
- Existing login tests: 47/47; headless tests: 30/30.
- Real browser shared settings controls: mobile/desktop and light/dark passed,
  identity isolation, hidden private fields and 401 revocation passed.
- Plugin/Web typecheck, i18n, platform boundaries, Web build and formal change-impact checks passed.
- Headless-profile Web bundle passed with the real opencraft-server Host definition.
- Full gate initially stopped on four missing separately locked DSH dependency tests;
  installed the isolated worktree runtime, reran DSH and all remaining gate commands successfully,
  including Web, Expo Web and iOS bundle builds. This is segmented gate verification.
- Repository context validator has 6291 baseline errors; own task/checkpoint metadata has zero errors.

## scan_scope / scan_output
Own changed source and docs only; report classifications, never credential values.
- Own plugin, fixture, tests and plugin documentation contain no literal API key/Bearer credential findings.

## handoff
Source implementation, scoped/browser/regression verification and user-authorized Git delivery are complete. Remote master contains the scoped source commit and integration commit. No preview restart or real credential configuration.

## git_delivery
- Read root/OpenCraft instructions, maintenance skill and verification, Gongfeng skill/dependencies, delivery flow and adjacency/test neighbor.
- Reused existing private Git credential helper without printing credential values; no existing mcporter connection is available.
- Latest fetched master is 5d9c122c5, with activity disclosure changes to preserve. Other untracked task records stay outside this commit.
- Source commit `615cf25b8` pushed to `feat/opencraft-tencentoa-20261006`.
- Merged latest master without conflicts in an independent worktree; integration commit `a0b2aa8f566bf1abe63a4c3b3a199f7c7b1741d0` pushed atomically to master and `integrate/opencraft-tencentoa-master-20261006`.
- Fresh merged-result verification passed: plugin/Web typecheck, boundaries, i18n, chat tests, login 47/47, Tencent OA 11/11, headless 30/30, real browser Tencent OA smoke and Headless-profile Web build. Built the independent worktree preview bridge prerequisite before the final Web build.
- Authenticated fetch after push and ancestry checks confirm remote master contains both source and integration commits. No force push, deployment or credential persistence.
