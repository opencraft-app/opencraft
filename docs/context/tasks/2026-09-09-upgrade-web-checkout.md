# 升配 Web checkout 与北京测试闭环

## 范围与基线
- 发布目标：`beijing-sandbox` / `https://lightclaw.tech` API，原 `https://lightclaw.pages.dev` 测试前端。`playground/sandbox-bj-7` 存在同事积分包分支独立改动且缺少升配基线；只在本地检验合并后撤销，未向该分支推送，禁止覆盖其配置。
- 用户授权：保留现有样式，完成账号升级入口、合法目标选择联动、实时差价确认、安全微信/国际支付、交付状态确认，并发布北京测试前后端。
- 基线：master `56a28c9f8`；分支 `codex/pass-upgrade-web-checkout`；工作目录 `/private/tmp/mono2-release-check-630f`。
- 不做：生产部署、计费配置/审批、新购业务重设计；不使用生产账号创建验证订单。
- 原 `/Users/shawnmy/code/mono2` 和 pass-modify 工作区的 dirty 改动保留不动。

## 执行清单
- [x] 核对 master 真实契约，确认 modify/order 缺 auth_code、modify/order-url 重复建单的问题。
- [x] 后端实现：两步式建单与支付链接分离、订单/Pass/用户归属、微信短期凭证、状态查询与缓存隔离；尚待北京真实验收。
- [x] 前端实现：现有账号/定价页最小增量、资格失败与状态变化处理、按 bundle ID 扩展关系。
- [x] 前端实现：差价确认、防连点与原订单重试、微信桥接、国际付款、刷新恢复与交付完成核验；不承诺跨设备原子 exactly-once。
- [x] 本地回归：安全、支付重试、状态矩阵、国内/国际、真实类型基线检查和构建；真实支付验收另列北京项。
- [ ] 北京：核实站点与后端环境、测试发布、公开入口与账号点测；记录请求/返回（脱敏）。

## 已读 context
- AGENTS.md 与 frontend/AGENTS.md、ctl/AGENTS.md、trade/AGENTS.md。
- docs/context/domains/subscription-entitlements.md、release-gitops.md。

## 验收边界
下单成功、支付完成、订单交付完成及目标 Pass active 分别记录；必须同一订单和 Pass 对齐，不以通用 HTTP 200 代替验收。

## 2026-09-09 验证检查点
- 当前分支本地聚焦前端回归：10 文件、128 项测试通过（包含 modal 9 项、实际档位联动、服务端恢复与翻译字典）。
- `pnpm run check`：翻译结构 0 错误、51 告警；繁体一致性通过；类型基线 191 current / 276 baseline / 0 new。
- 国内/国际站最新 `build:next` 均完成，API 指向北京测试；分别 8 / 42 条公开静态路由 SEO 检查通过。
- `git diff --check` 通过。尚未 commit、push、触发发布或创建真实支付订单。
- Trade 全量 test/vet 与 CTL 受影响包 test/vet 通过；网关精确路由契约通过。CTL 全量集成依赖本机 lightginkgo 配置及 Docker，未在本机完成，不能声明全量通过。
- 只读审查后修复：轮询不再清除支付错误；只有同单服务端 cancelled 终态才释放本地记录，两项回归先失败后通过。
- 正式领域/旅程文档已同步，文档校验通过。前端没有独立 lint 脚本，以项目 check/i18n/类型基线及组件测试作为本地门禁。
- 用户已授权提 MR、审查通过后浏览器评论 `ok` 并同意合入、北京测试部署；不授权生产阶段确认或发布。尚待 CI、GitOps/Argo 及北京真实恢复 DAO/扫码/交付验收。
