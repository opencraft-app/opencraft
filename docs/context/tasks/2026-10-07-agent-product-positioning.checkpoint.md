## stage
独立工作树中的文案修改及验证完成，准备提交 MR；未发布。

## verified
- 文档源与站点元信息中的旧产品定义已改为“云端 AI Agent 产品”或对应语言表达。
- 8 个 locale 的两篇目标文档生成产物已核对；日语旧定位测试断言已更新。
- `pnpm docs:sync`、`pnpm check`、双站构建、OpenCraft 同步检查与 `git diff --check` 通过。
- 按用户后续澄清，Tencent Lighthouse 与 Tencent Cloud Lighthouse 均可，未统一英文名称。

## unverified
- 聚焦 Vitest 在测试进程内临时映射 `localhost` 至 `127.0.0.1` 后通过：6 个文件、108 项测试。
- 线上发布与真实浏览器页面未验证。

## discard
- “必须统一英文名称为 Tencent Cloud Lighthouse”已被用户后续澄清取代。

## restore
- 任务记录：`docs/context/tasks/2026-10-07-agent-product-positioning.md`。
- 文档源位于 `frontend/src/content/docs/`；站点元信息位于 `frontend/src/app/`、`frontend/src/lib/seo-data.ts` 和 `frontend/next-site/seo.tsx`。
- 本次变更已从主工作区移入基于最新 `origin/master` 的独立工作树。

## next_action
- 暂存变更的 change-impact 门禁已通过；提交分支并创建 MR，发布需另行处理。
