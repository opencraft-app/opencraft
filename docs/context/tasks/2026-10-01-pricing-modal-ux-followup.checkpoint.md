## stage
MR !4879 的优化已提交到本地分支，并合入验证时的最新 master；下一步推送分支并核对 MR。

## verified
- 当前无 Bot 的已订阅用户直接进入创建引导，当前有 Bot 进入列表；历史订阅保护已到期用户的管理入口。
- 页头免费试用、首页和页脚转化入口打开定价弹窗；顶部导航价格仍进入独立定价页。
- 合入 `origin/master@7eb0d7227` 无冲突，主链路 299 例与合并相关 4 例定向测试通过。
- `pnpm check` 0 新增类型错误；文档校验 0 错误；双站 Webpack 生产编译成功。

## unverified
- 全量前端测试存在旧用例失败并触发 worker 内存耗尽；默认 Turbopack 构建持续无进展，结果未确认。
- 支付回跳仅有套餐 ID，订单级自动核对仍需另行处理；未进行生产部署验证。

## discard
- 浏览器本地“曾创建 Bot”标记；当前服务端 Bot 列表为空就按创建引导处理。

## restore
- 分支：`codex/prd-pricing-onboarding`；MR：`https://git.woa.com/wisp/mono2/-/merge_requests/4879`。
- Task Pack：`docs/context/tasks/2026-10-01-pricing-modal-ux-followup.md`。

## next_action
- 推送分支后核对 MR 的源分支、目标 master 与远端提交。
