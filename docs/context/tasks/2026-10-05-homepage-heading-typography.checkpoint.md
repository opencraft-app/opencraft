## stage
国际首页标题字体改动已验证；过期套餐首页 CTA 已按现有 Bot 场景改为返回 Agents，等待用户可能的进一步修正。

## verified
- `deploy__lead` 错误命中英文字体 `--font-cover-en`；相邻两个标题实际使用 `--font-sans`。
- 国内 `zh-CN` 首页不命中该衬线规则。
- 标题改动的生成脚本测试 25 项通过；首次首页渲染测试因资源版本断言需同步，已修正。
- 首次 typecheck 因 worktree 缺少 `collections/server` 生成物失败，非本次源码诊断。
- 补齐生成物后 typecheck / check 通过，最终 CTA 方案的国内及国际构建均通过；聚焦测试 90/90 通过。
- 全量测试中其他模块有失败并出现 Node OOM，已中止。

## unverified
- 用户是否接受“我的智能体伙伴 → /agents”的工作假设；全量测试因其他模块失败和 OOM 无完整通过结果。

## discard
- 初次渲染测试失败的旧版本字符串；已以导出的版本常量替代。

## restore
- 工作目录：`/Users/pablozhong/.codex/worktrees/homepage-heading-typography/lightvela`；主检出有大量用户改动，不要切回修改。
- 新目标 Task Pack：`docs/context/tasks/2026-10-05-expired-home-cta.md`。

## next_action
- 清理构建生成的 `next-env.d.ts` 改动、复查 diff；如用户进一步指定 CTA 行为，按其选择调整。
