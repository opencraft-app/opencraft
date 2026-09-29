## stage
文案、聚焦验证、双站构建及差异检查已完成；可交接。

## verified
- `/account` 的 ID 标签来自 `frontend/src/pages/marketing/account-page.tsx` 的单一展示点。
- 七种字典包含新键 `k_fff0e138`，标签与占位符已逐一核对。
- `pnpm check` 通过；账号页聚焦测试 45/45 通过。
- `pnpm build:cn` 和 `pnpm build:global` 均通过；构建产物噪音已恢复。
- 当前 HEAD 基线的韩语字典含 5 个中文基准字典没有的旧键，字典测试同时要求键集相等及其中一个旧键存在。

## unverified
- 未在真实登录账号的网页上截图；本地组件测试覆盖显示及复制行为。

## discard
- 提取脚本引起的无关字典排序改动已移除。

## restore
- 独立工作树：`/Users/pablozhong/.codex/worktrees/account-id-copy/lightvela`。
- 保留韩语旧键，不修改与本轮文案无关的基线冲突。

## next_action
- 交接本地改动及字典测试的基线限制。
