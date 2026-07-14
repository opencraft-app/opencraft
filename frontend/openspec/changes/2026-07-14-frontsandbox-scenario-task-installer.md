# 变更记录：LightVela 场景任务安装器 v1

> **日期：** 2026-07-14
> **分支：** `frontsandbox/scenario-task-installer`
> **规模：** M（single_agent）
> **TAPD：** [#135720398](https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091135720398)
> **MR：** 
> **HEAD commit：** `a2dee9ac`
>
> 本记录为补归档：归档执行发生在 `frontsandbox/hermes-agent-name-investigation` 隔离分支，业务需求来源以 `plan.md` / `current_state.md` 中记录的 `frontsandbox/scenario-task-installer` 为准，避免将旧需求误标到当前 Hermes 名称清理分支。

---

## 一、需求概要

用户进入 `/agents/automations` 时已经能创建 Hermes Cron 自动任务，但页面心智仍偏“配置表单”。本需求把首个自动任务路径前移为“选一个场景先跑一次”：用户从明确目标进入，填写少量业务字段，通过一次性执行看到试跑结果，再把同一份配置添加为常态化自动任务。

首发四个场景：A 股财经早报、世界杯今日赛况、每日新闻、AI 发展动态。v1 复用现有 Hermes Cron 能力，不新增后端调度接口；试跑下发后立即开始，创建成功后通过微信 / QQ 发送接单确认，结果稍后主动推送。国际站首版暂不展示场景任务入口。

## 二、任务完成情况

18/18 个任务完成。

- [x] 1. 新增 `scenario-tasks` 场景配置和 builder。
- [x] 2. 为 `scenario-task-builder` 补单元测试。
- [x] 3. 新增 `ScenarioTaskGrid` 和场景卡。
- [x] 4. 新增 `ScenarioInstallModal`。
- [x] 5. 新增试跑提示承接和 `ScenarioEnableConfirmModal`。
- [x] 6. 在 `AutomationsPanel` 中接入 Cron 创建和轮询。
- [x] 7. 更新 i18n 字典。
- [x] 8. 运行目标验证。
- [x] 9. 在场景安装步骤中复用微信 / QQ 扫码通道回传。
- [x] 10. 收紧四个场景提示词，显式指定执行工具和信息获取方式。
- [x] 11. 场景安装弹窗内联完成微信 / QQ 连接。
- [x] 12. 通道连接改为实例内 exec 调用 `acli gateway qr-url`。
- [x] 13. 将场景安装弹窗拆为任务设置和消息通道两步。
- [x] 14. 将场景试跑改为下发后立即开始。
- [x] 15. 国际站首版屏蔽场景任务入口，并修复 review 发现的弹窗可访问性和废弃代码问题。
- [x] 16. 修复微信 / QQ 扫码接入命令一直 pending 时无法展示二维码的问题。
- [x] 17. 修复 frontend 分支预览发布器拉取 master runtime 的鉴权失败。
- [x] 18. 隔离 frontend 分支预览双产物构建的 Next 缓存。

## 三、关键决策

- 决策 1：选择“前端场景安装器 + 复用 Hermes Cron”，不新增 `runScenarioOnce` 后端接口。原因是 v1 的目标是最快验证“先跑一次 -> 添加为自动任务”的用户路径，复用 Cron 能避免调度语义扩散到后端。
- 决策 2：国际站首版不展示场景任务入口。原因是国际站通道能力和场景内容尚未准备完整，避免用户进入无法闭环的流程。
- 决策 3：场景配置、prompt 生成和 schedule 生成下沉到 `scenario-task-builder.ts`，React 组件只消费配置和 draft，降低 JSX 中拼接长 prompt 的维护风险。
- 决策 4：微信 / QQ 二维码接入走实例内 `debug/exec` 流式读取 `acli gateway qr-url --platform <platform> --wait true`。因为 `--wait true` 会在扫码完成前保持 pending，同步等待命令结束会导致二维码无法及时展示。
- 技术选型理由：未引入新重型依赖；UI 弹窗复用项目已有 Radix Dialog primitive，保留焦点管理、Escape 关闭和 `aria-modal` 等可访问性能力。

## 四、实施摘要

- 文件改动：业务实现已在源分支完成；本次补归档分支只写入 OpenSpec 归档和状态清理文件。
- 关键 commits：当前补归档基线为 `a2dee9ac`。
- 验证结果：`plan.md` 记录的 18 个任务均已完成；目标验证覆盖 builder 单测、i18n 检查、类型检查，以及登录态受限时的未覆盖项说明。
- 质量重点：实时类 prompt 增加 `datetime` / `web_search` / `web_fetch` 使用边界；微信 / QQ 扫码改为 SSE 流式读取；国际站用 `isGlobal` 阻断入口和相关弹窗。

## 五、规范沉淀

本次无独立 Delta Specs 目录。关键约束已沉淀在本归档：

- `/agents/automations` 的场景任务入口首版仅国内站展示。
- 试跑任务和常态任务来自同一份 draft，仅替换 schedule 和 name。
- 场景安装 UI 首版只允许 `weixin` / `qqbot` 主动推送目标；底层 builder 保留 `local` 仅用于历史数据兼容。
- `acli gateway qr-url --wait true` 必须走流式 `debug/exec`，关闭弹窗、重新生成二维码或刷新通道状态时需要 abort 旧请求。

## 六、回顾与改进

### 踩坑记录

- 坑 1：二维码命令一直 pending 时，若使用同步 debug/exec，会等不到命令结束而无法展示二维码。解决方案是改成 SSE 流式读取 stdout，一旦出现二维码链接就立即展示。
- 坑 2：Next 双产物构建可能复用 `.next` / webpack cache，导致 `cn -> global` 顺序构建时第二段失败。解决方案是在 build:next、preview variant 构建和 release artifact 构建前清理 `.next`。
- 坑 3：分支预览发布器从 CI checkout 的匿名 HTTP `origin` 拉取 master runtime 会鉴权失败。解决方案是通过 `.ci/init.sh` 的 `ci_git_fetch_origin` 走 SSH 或 Git WOA token fallback。

### 可复用经验

- 场景化能力优先抽象为配置 + builder，页面组件只负责状态流和交互承接，这种结构更容易补单测，也方便后续扩展场景市场。
- 对实例内长等待命令，前端应优先使用流式 debug/exec，并在 UI 生命周期结束时 abort，避免旧请求泄漏或污染新状态。
- 国际站未准备好的能力用编译期 `isGlobal` 在入口、弹窗和提示条层面整体屏蔽，比只隐藏一个按钮更稳。

### 未实现 / 后续优化

- P1：后续可引入后端 metadata 或专用试跑接口，让最近执行匹配不再依赖任务名 / prompt 兜底。
- P1：国际站通道和场景内容准备完成后，再开放场景任务入口。
- P2：场景市场、用户偏好、新闻来源偏好等能力留待后续产品化迭代。
