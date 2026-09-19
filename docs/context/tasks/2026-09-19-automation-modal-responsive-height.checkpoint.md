## stage
已提交 MR !4305；等待评审与 CI。

## verified
- 新建、编辑和模板表单共用 `AutomationFormModal`。
- 当前常见表单固定为 840px；高级设置为非受控 `details`。
- 内容滚动区与底部操作区已经分离。
- 高级设置收起时弹窗使用 720px，展开后使用 840px；两者均受 `100dvh - 16px` 上限约束。
- Radix ScrollArea 改为仅在内容溢出时显示滚动条，底部操作区保持在滚动区之外。
- 聚焦测试 197/197、`pnpm check`、`pnpm build:cn` 通过，新增 TypeScript 诊断为 0，国内站构建生成 103 个静态页面。
- Chrome 1333×736 视口中，收起状态实际高度 720px；展开后 840px 高度请求被视口上限压到 720px，右侧滚动条出现，footer 顶部位置保持 654px。
- 功能提交 `de1c3841d` 已推送到 `codex/automation-modal-responsive-height`，远端 SHA 与本地一致。
- MR !4305 已创建，目标分支为 `master`；创建时状态为 opened、can_be_merged。

## unverified
- 当前账号没有现成自动任务，编辑态通过共享组件代码与 `mode="edit"` 回归测试验证，未进行真实编辑弹窗截图。

## discard
- 不采用新的滚动组件或修改表单业务字段。

## restore
- 工作目录 `/Users/pablozhong/codex/lightvela-automation-modal-responsive`。
- 分支 `codex/automation-modal-responsive-height`，基于 `origin/master` 的 `3bc843130`。

## next_action
- 等待 MR !4305 的 CI 与评审；本任务不包含合并或发布。
