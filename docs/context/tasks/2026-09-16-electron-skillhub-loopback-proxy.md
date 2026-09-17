## goal

Serve the public SkillHub catalog to the Electron renderer through a fixed desktop capability, avoiding browser CORS without granting arbitrary proxy access.

## non_goals

- Do not alter SkillHub CORS, credentials, login state, or public web behavior.
- Do not create a general URL proxy, forward cookies, or permit renderer-chosen upstreams.

## requirement_ids / requirement_refs / requirement_excerpt

- User request: use desktop-side infrastructure so Skills loads without renderer cross-origin requests.

## interface_refs / data_structure_refs

- `opencraft/apps/workbench-electron/src/skillhub-http.ts`: Electron Main's fixed SkillHub network capability.
- `frontend/src/lib/skillhub-api.ts`: public SkillHub client and desktop source boundary.
- Invariant: renderer can request only fixed GET/HEAD paths below the SkillHub public API; upstream authority remains `https://api.skillhub.cn`.

## history_context

- `current_design_refs`: `opencraft/docs/build-matrix.md`, `opencraft/docs/platform-architecture.md`.
- `relevant_evolution`: public site origins receive SkillHub CORS allowance; Electron loopback does not.
- `superseded_refs`: none.

## acceptance

- Electron uses a preloaded, named SkillHub capability.
- Web release still fetches the official SkillHub origin.
- Capability rejects paths outside the fixed SkillHub API.
- Capability does not pass cookies, credentials, arbitrary renderer request headers, or arbitrary redirects.
- Skill file downloads may follow one redirect to SkillHub's fixed public artifact CDN; every other redirect target is rejected.

## affected_paths

- `frontend/src/lib/skillhub-api.ts`
- `opencraft/apps/workbench-electron/src/skillhub-http.ts`
- `opencraft/apps/workbench-electron/src/main.ts`
- `opencraft/apps/workbench-electron/src/preload.ts`
- generated `opencraft/plugins/lightvela-hermes/src/upstream/mono2/lib/skillhub-api.ts`
- focused tests for both client selection and desktop capability validation.

## required_context

- OpenCraft maintenance, desktop-apps, and trace guidance.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/docs/build-matrix.md` | Electron origin contract | Preserve static loopback ownership. |
| `opencraft/apps/workbench-electron/src/skillhub-http.ts` | Desktop network boundary | Restrict remote host and request path. |
| `frontend/src/lib/skillhub-api.ts` | Renderer call site | Select the desktop capability only on Electron. |

## evidence

- `api.skillhub.cn` returned HTTP 200; it allows `lightvela.com` and `lightvela.ai`, but not Electron's `127.0.0.1` origin.

## risks

- A generic relay would become SSRF; constrain host, path, request headers, redirects, and response size.
- SkillHub's file-content endpoint currently returns HTTP 302 to its public COS artifact origin. Rejecting every redirect breaks installation even while catalog reads remain healthy.

## validation

- `frontend` SkillHub unit test: 19 passed.
- `npm run check:mono2-agent-console`: passed.
- 2026-09-17: `npm run test:appserver`: 162 passed, including allowed-CDN and rejected-external-redirect coverage.
- 2026-09-17: the real desktop bridge function fetched `tushare-data/SKILL.md` through the live API redirect with HTTP 200 and 17,758 bytes.
- `npm run typecheck`, `git diff --check`, and `frontend pnpm check`: passed (frontend reported existing translation warnings but no errors).
- Current desktop preview is an old bundle; isolated desktop preview verification remains pending.

## decisions

- Reuse WorkBuddy's named desktop capability boundary: renderer calls a narrow preload IPC surface, while the Main process owns fixed-host network I/O.

## scan_scope

- Electron main/preload, SkillHub client, generated frontend closure, and relevant tests.

## scan_output

- Static server intentionally retains no proxy API. `ref/wb` uses a typed Skills facade through renderer/backend IPC; this change mirrors that capability boundary.

## handoff

- 2026-09-17 installation diagnosis: catalog and Node fetch both returned 200, while every sampled skill file endpoint returned 302 to `skillhub-1388575217.cos.accelerate.myqcloud.com`; the desktop bridge's `redirect: "error"` converted that expected response into the generic connection failure.
- Source fix is uncommitted. Existing desktop preview processes still run old bundles until rebuilt.
