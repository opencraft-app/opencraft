## stage
根据用户复审调整入口并修复到期提示遮挡“+”；代码与本地预览完成，用户已授权更新既有 MR !4222。

## verified
- 交付前本工作树 HEAD/远端为 `f2d8a6846`，本轮修改在该提交之上；旧预览工作树未改动。
- 创建入口为重启图标左侧的“+”，多 Bot 下拉箭头位于删除图标之后；旧 `…` 菜单及整行按钮移除，原 `show()`、功能开关、额度逻辑保留。
- 相邻测试 58/58、`pnpm check`、`pnpm build`、`git diff --check`、文档校验、精确文件 change-impact 校验通过。构建产生的两个生成文件改动已清理。
- 国内站本地预览 `http://127.0.0.1:5174/agents/models/` 已在登录浏览器使用 `show()` 验证图标顺序，并展开现有多 Bot 列表；未操作真实 Bot。
- 后续到期提示重叠修复：气泡改从到期徽标下方展开；3 个相关测试文件 21/21、`pnpm check`、`pnpm build` 通过，Chrome 实际悬停到期徽标与“+”均符合预期。未点击续费或创建。
- 完整测试集有 133 个失败及 worker OOM，见 Task Pack，尚未验证独立基线。

## unverified
- 新提交的远端 CI 与合并状态需在推送后再次查询；完整测试集失败未独立基线复现。

## discard
- 旧工作树的 725 提交落后基线及其构建结果，不用于本 MR 交付证明。

## restore
- 工作树 `/Users/pablozhong/codex/lightvela-bot-create-overflow-mr`，分支 `codex/bot-create-overflow`。
- Task Pack `docs/context/tasks/2026-09-17-bot-create-overflow.md`。

## next_action
- 暂存精确文件、运行 staged change-impact、提交并推送，再核对既有 MR !4222 的远端 SHA 与 CI；不合并或发布。
