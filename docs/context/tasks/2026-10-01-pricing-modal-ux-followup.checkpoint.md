## stage
MR !4879 已补齐 OpenCraft 生成副本，合入 2026-10-01 最新 master，并处理新上游引入的测试 mock 依赖。MR 仍为 Draft；双站预览正在构建。

## verified
- 当前无 Bot 的已订阅用户直接进入创建引导，当前有 Bot 进入列表；历史订阅保护已到期用户的管理入口。
- 页头免费试用、首页和页脚转化入口打开定价弹窗；顶部导航价格仍进入独立定价页。
- 原先合入 `origin/master@7eb0d7227` 后，主链路 299 例与合并相关 4 例定向测试通过。
- `pnpm check` 0 新增类型错误；文档校验 0 错误；双站 Webpack 生产编译成功。
- MR 占位检查失败定位到 `frontend/src/components/ui/dialog.tsx` 的 OpenCraft 机械副本漂移；运行官方同步脚本后，130 文件只读同步检查通过。
- 合入 `origin/master@db673bbb9`，OpenCraft 清单冲突由官方脚本重生解决；`pnpm check` 0 新增类型错误，创建意图 8/8 测试通过。新 master 增加的 `useReferralEnabled` mock 与稳定仓库对象已补齐。

## unverified
- 全量前端测试存在旧用例失败并触发 worker 内存耗尽；默认 Turbopack 构建持续无进展，结果未确认。
- 支付回跳仅有套餐 ID，订单级自动核对仍需另行处理；未进行生产部署验证。
- 最新 MR 必要检查和双站分支预览尚待远端构建结果；真实支付与登录态仍待人工验收。

## discard
- 浏览器本地“曾创建 Bot”标记；当前服务端 Bot 列表为空就按创建引导处理。

## restore
- 分支：`codex/prd-pricing-onboarding`；MR：`https://git.woa.com/wisp/mono2/-/merge_requests/4879`。
- Task Pack：`docs/context/tasks/2026-10-01-pricing-modal-ux-followup.md`。

## next_action
- 推送合入 master 后的分支和预览分支，等待远端检查与双站预览成功；将可访问地址加入 MR 描述，供人工走查。
