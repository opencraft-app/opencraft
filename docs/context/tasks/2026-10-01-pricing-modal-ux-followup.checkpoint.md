## stage
MR !4879 已补齐 OpenCraft 生成副本并合入最新 master。当前继续修复退款规则入口：旧版国内站入口在长套餐卡底部，国际站文档有规则但定价页没有入口；已在本地把双站入口放到卡片上方，补齐印尼语文档，待提交与预览。

## verified
- 当前无 Bot 的已订阅用户直接进入创建引导，当前有 Bot 进入列表；历史订阅保护已到期用户的管理入口。
- 页头免费试用、首页和页脚转化入口打开定价弹窗；顶部导航价格仍进入独立定价页。
- 原先合入 `origin/master@7eb0d7227` 后，主链路 299 例与合并相关 4 例定向测试通过。
- `pnpm check` 0 新增类型错误；文档校验 0 错误；双站 Webpack 生产编译成功。
- MR 占位检查失败定位到 `frontend/src/components/ui/dialog.tsx` 的 OpenCraft 机械副本漂移；运行官方同步脚本后，130 文件只读同步检查通过。
- 合入 `origin/master@db673bbb9`，OpenCraft 清单冲突由官方脚本重生解决；`pnpm check` 0 新增类型错误，创建意图 8/8 测试通过。新 master 增加的 `useReferralEnabled` mock 与稳定仓库对象已补齐。
- 当前 head `15534342d` 的占位文案和禁用按钮已按评论修复：占位判断使用 `plan.features.length === 0`，禁用态配色使用 `disabled`；`查看全部套餐` 的新 key `k_c063bbc7` 已覆盖全部目标语种，旧 key 存留不影响使用。
- 退款入口变更后，国内与国际订阅页 2 文件 123 例通过；`pnpm check` 通过，6 个目标语种齐全、0 新增类型错误。国际站英文、简中、繁中、西语、日语、韩语现有文档的规则锚点已核对；印尼语内容随本次新增。

## unverified
- 全量前端测试存在旧用例失败并触发 worker 内存耗尽；默认 Turbopack 构建持续无进展，结果未确认。
- 支付回跳仅有套餐 ID，订单级自动核对仍需另行处理；未进行生产部署验证。
- 新增退款入口尚待推送与双站预览；MR 必要检查仍应按最新流水线确认，真实支付与登录态仍待人工验收。

## discard
- 浏览器本地“曾创建 Bot”标记；当前服务端 Bot 列表为空就按创建引导处理。

## restore
- 分支：`codex/prd-pricing-onboarding`；MR：`https://git.woa.com/wisp/mono2/-/merge_requests/4879`。
- Task Pack：`docs/context/tasks/2026-10-01-pricing-modal-ux-followup.md`。

## next_action
- 提交退款入口和文档变更，推送 MR 与预览分支；更新 MR 描述，等待最新检查并核对双站退款链接。
