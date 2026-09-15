## goal

Restore local Whistle and Next.js blog loading by ensuring the repository-local `@lightvela/agent-core` dependency is installed and resolvable.

## non_goals

- Do not change Blog content, cover images, routing behavior, or production configuration.
- Do not change the `@lightvela/agent-core` API or move the package.
- Do not publish, commit, push, or deploy.

## requirement_ids / requirement_refs / requirement_excerpt

- User request: fix the reported Whistle Blog loading build error.
- Reported failure: Next.js cannot resolve `@lightvela/agent-core` from the public-site provider import graph.

## interface_refs / data_structure_refs

- `frontend/package.json` declares `@lightvela/agent-core` as `file:../shared/lightvela-agent-core`.
- `frontend/pnpm-lock.yaml` records the same repository-local package resolution.
- `frontend/next-site/public-site-app-providers.tsx` imports `src/contexts/agent-context.tsx`.
- `frontend/src/contexts/agent-context.tsx` imports `@lightvela/agent-core`.

## history_context

- The dependency was added to `frontend/package.json` by commit `9926364c9a4d4917ae926c3131eebf18c98351c5` on 2026-09-15.
- The current ignored `frontend/node_modules` directory was materialized on 2026-09-08 and lacks the package link.
- The preview build script already runs `pnpm install --frozen-lockfile` in a clean workspace.

## acceptance

- `frontend/node_modules/@lightvela/agent-core` resolves to `shared/lightvela-agent-core`.
- The reported `@lightvela/agent-core` module-not-found error no longer occurs in a global Next.js build.
- The Blog route loads through the local Next.js server.
- No tracked Blog or production behavior changes are introduced.

## affected_paths

- `frontend/node_modules/` ignored local dependency state.
- `frontend/package.json` and `frontend/pnpm-lock.yaml` inspected only.
- `frontend/next-site/public-site-app-providers.tsx` and `frontend/src/contexts/agent-context.tsx` inspected only.

## required_context

- `frontend/AGENTS.md`
- `docs/context/project/services/frontend.md`
- `docs/context/tasks/2026-09-12-mono2-agent-core.md`
- `docs/developer-guide/frontend-whistle-proxy.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端边界与验证命令 | 确认依赖、类型和构建门禁 |
| `docs/context/project/services/frontend.md` | 前端服务验证边界 | 确认双站构建与测试要求 |
| `docs/context/tasks/2026-09-12-mono2-agent-core.md` | 解释本地 package 的设计与既有构建证据 | 确认 package 是预期共享边界 |
| `docs/developer-guide/frontend-whistle-proxy.md` | Whistle 本地联调入口 | 按用户路径复现本地 dev server |
| `AGENTS.md` | 仓库级安全与交接边界 | 保持不发布、不提交并保留命令证据 |

## evidence

- `NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm exec next build` reproduced the exact reported module-not-found error.
- The import trace reached `src/app/(site)/blog/page.next.tsx` through `next-site/public-site-app-providers.tsx`.
- `frontend/package.json` and `frontend/pnpm-lock.yaml` already contain the local package declaration.
- `frontend/node_modules/@lightvela/` lacks the `agent-core` link before reinstall.
- `pnpm install --frozen-lockfile` restored the `frontend/node_modules/@lightvela/agent-core` link.
- The global Next build then compiled successfully and generated 628 static pages.
- The local browser rendered `/blog/` and a Blog article route with the expected PNG cover assets.
- Focused Blog/provider tests passed: 6 files and 15 tests.
- `pnpm i18n:check`, `pnpm check`, `pnpm build:global`, and `git diff --check` passed.

## risks

- A stale local install can recur after pulling commits that add dependencies.
- The fix must not loosen the frozen lockfile or introduce a second package source.

## validation

- Run `pnpm install --frozen-lockfile` in `frontend/`.
- Run the global Next.js production build.
- Run the focused Blog and public-site provider tests.
- Start the global dev server and request `/blog` through the local server.
- Run `git diff --check` and confirm no tracked source changes are introduced.

## decisions

- Repair the dependency installation state because the manifest and lockfile are already correct.
- Do not add a runtime shim or remove the shared package import from the public-site provider graph.
- Keep the tracked fix limited to this Task Pack; the dependency repair itself is ignored local installation state.

## scan_scope

- `frontend/package.json`
- `frontend/pnpm-lock.yaml`
- `frontend/next-site/`
- `frontend/src/contexts/`
- `frontend/src/repositories/`
- `.ci/runtime/commands/publish_frontend_preview.sh`

## scan_output

- Bounded exact search output was kept in the agent turn evidence.
- No external scan artifact was created.

## handoff

- Current status: repaired and verified locally.
- Next step: restart the user's Whistle dev server after running `cd frontend && pnpm install --frozen-lockfile` in any stale checkout.
- Blockers: none.
