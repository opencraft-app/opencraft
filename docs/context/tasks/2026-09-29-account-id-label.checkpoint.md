## stage
文案、聚焦验证、双站构建及差异检查已完成；可交接。

## verified
- `/account` 的 ID 标签来自 `frontend/src/pages/marketing/account-page.tsx` 的单一展示点。
- 七种字典包含新键 `k_fff0e138`，标签与占位符已逐一核对。
- `pnpm check` 通过；账号页聚焦测试 45/45 通过。
- `pnpm build:cn` 和 `pnpm build:global` 均通过；构建产物噪音已恢复。
- 合入最新 `master` 后，字典与账号页聚焦测试 63/63 通过，旧韩语键的基线冲突已由目标分支清理。

## unverified
- 未在真实登录账号的网页上截图；本地组件测试覆盖显示及复制行为。

## discard
- 提取脚本引起的无关字典排序改动已移除。

## restore
- 独立工作树：`/Users/pablozhong/.codex/worktrees/account-id-copy/lightvela`。
- 保留目标分支已清理的韩语字典，并同步本次翻译键到 OpenCraft vendored 闭包。

## next_action
- 交接本地改动及字典测试的基线限制。
