---
id: cn-docs-batch-three-checkpoint-2026-09-28
type: task
scope: 国内站中文文档第三批修改的续接状态。
triggers: ["cn docs", "国内站文档", "checkpoint"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-28-cn-docs-batch-three.md
status: active
reviewed_at: 2026-09-28
review_due: 2026-12-28
revision: 1.0.0
precedence: task
derived: false
---

## stage
第三批国内站中文文档已完成技能、记忆、云存储、通道测试、三篇定时任务场景、套餐积分和三篇对比页的修改；本地验证和交接复核已完成。

## verified
- origin/master@939c01b03119530c22128205ba64ea73e6c7ca2a 为本分支基线，初始工作树干净。
- 国内站通道测试按钮只对已连接通道开放；成功提示要求用户去聊天软件确认实际收到。
- 2026-09-28 生产订阅页显示启航与巡游两张套餐卡，分别可选 100/4500 与 200/10000 模型积分档；Bot 数分别展示 5/10；页面另售五档积分包，要求有效套餐、有效期一个月。
- subscription-entitlements 与 credit-service-detail Context 已读取，积分包与套餐积分有独立的生命周期。
- `pnpm docs:sync` 成功，同步 513 篇文档；22 篇改动源文档的 214 个相对文档/图片引用均存在并在国内站注册。
- 三篇定时任务场景页与三篇对比页各超过 3000 个中文字符。
- `pnpm check`、`pnpm build:cn`、38 项聚焦测试、文档 validator 与变更影响检查通过。
- 22 份改动源文档均有国内站 zh-cn 生成文件且摘要同步；`git diff --check` 通过。

## unverified
- 当前价格、优惠与可售状态可能随活动改变；产品文档应链接实时订阅页，不把本次观察写成长期承诺。
- 旧文档的退款、到期保留和升配细节尚未逐项与在线账号状态验证，不改动其业务规则。
- 全量 `pnpm test` 未通过：首次为本机 `localhost` DNS 失败，改为 `127.0.0.1` 后出现多处未修改区域既有失败并被中断；摘要聚焦测试仅余 16 篇未修改国际站源文档缺摘要。
- `validate_context --build-catalog` 与 Context 单测存在仓库既有错误；补齐本检查点后，本任务文件未出现在剩余 3704 条错误或 4 项失败测试信息中。

## discard
- “国内站积分不能单独购买”“当前只能创建一个 Bot”“四档独立套餐”的旧文档表述。

## restore
- 分支 codex/cn-docs-batch-three，工作目录为本 Task Pack 所在工作树。
- 当前任务 Pack：docs/context/tasks/2026-09-28-cn-docs-batch-three.md。

## next_action
- 用户已授权提交本批 MR；完成聚焦门禁后 commit、push，创建 MR 并核对远端状态。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户在第三批文档复查后要求“修改吧”；范围与验收见同名 Task Pack。

## interface_refs / data_structure_refs
- `frontend/src/config/docs-sidebar.ts`、`frontend/scripts/sync-fumadocs-content.mjs`：国内站 slug 和渲染元数据。

## history_context
- current_design_refs: `docs/context/domains/site-environment-routing.md` 与 `docs/context/domains/subscription-entitlements.md`。
- relevant_evolution: 本分支以第二批文档合并后的 `origin/master@939c01b03119530c22128205ba64ea73e6c7ca2a` 为基线。
- superseded_refs: 本批修订前的单 Bot、无额外积分包和旧技能入口说法。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/tasks/2026-09-28-cn-docs-batch-three.md@working-tree` | 主任务记录 | 本检查点的事实与验证依据 |
