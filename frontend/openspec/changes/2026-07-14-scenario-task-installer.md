# 变更记录：LightVela 场景任务安装器 v1

> **日期：** 2026-07-14
> **需求来源分支：** `frontsandbox/scenario-task-installer`
> **归档执行分支：** `frontsandbox/update-memory-copy`
> **规模：** M（single_agent）
> **TAPD：** [#135720398](https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091135720398)
> **MR：** 当前归档上下文未识别
> **归档时 HEAD：** `7e923a7e`
> **最终产品状态：** 场景任务底层实现保留，但国内站与国际站均不展示场景任务卡片

---

## 一、需求概要

本需求最初希望把 `/agents/automations` 的首个自动任务路径前移为“选择场景、先跑一次、再添加为周期任务”。实现复用了 Hermes Cron，提供四个场景的配置、prompt 与 schedule builder、微信/QQ 回传、弹窗内扫码、一次性试跑和周期任务创建，并补齐前端分支预览与双产物构建稳定性。

在后续产品收敛中，场景任务卡片从自动任务页下线。最终状态为：标准自动任务模板、添加、编辑、暂停、恢复、删除和最近执行能力保持不变；`scenario-tasks` 配置、builder、弹窗和测试代码仍保留，但没有用户可达入口，国内站与国际站均不渲染场景卡片。

### 变更类型与影响范围

- **变更类型：** 功能实现、体验优化、稳定性修复、产品入口下线。
- **影响模块：** Agent 控制台自动任务、Hermes Cron 客户端、微信/QQ 扫码接入、前端预览流水线、Next 双产物构建、Agent 记忆页说明。
- **兼容性：** 不改变现有普通 Cron 任务数据结构和 CRUD 行为；场景任务入口下线不删除底层实现，也不迁移或删除已有普通自动任务。
- **破坏性变更：** 无。

## 二、任务完成情况

21/21 个任务完成。

- [x] 1. 新增 `scenario-tasks` 场景配置和 builder。
  - 四个首发场景可生成 name、prompt、一次性 schedule、周期 schedule、deliver 和最近执行匹配结果。
- [x] 2. 为 `scenario-task-builder` 补单元测试。
  - 覆盖财经非投资建议、AI 动态内容边界、一次性/周期 schedule 和最近执行匹配。
- [x] 3. 新增 `ScenarioTaskGrid` 和场景卡。
  - 组件实现保留；最终产品入口已在任务 21 下线。
- [x] 4. 新增 `ScenarioInstallModal`。
  - 支持按场景填写字段、查看摘要、选择频率和微信/QQ 回传。
- [x] 5. 新增试跑提示承接和 `ScenarioEnableConfirmModal`。
  - 试跑创建后提示已开始处理，并可进入周期任务确认。
- [x] 6. 在 `AutomationsPanel` 中接入 Cron 创建和刷新。
  - 一次性试跑与周期任务复用现有 Cron 创建链路。
- [x] 7. 更新 i18n 字典。
  - 中文与英文文案完成抽取和校验。
- [x] 8. 运行目标验证。
  - 目标单测、类型检查和 i18n 门禁通过。
- [x] 9. 在场景安装步骤中复用微信/QQ 扫码通道回传。
  - 试跑和周期 Cron 共用同一份 deliver。
- [x] 10. 收紧四个场景提示词，显式指定执行工具和信息获取方式。
  - 实时类场景限制检索范围、网页来源数量并保留来源。
- [x] 11. 场景安装弹窗内联完成微信/QQ连接。
  - 未连接时在当前弹窗内打开连接子弹窗。
- [x] 12. 通道连接改为实例内 exec 调用 `acli gateway qr-url`。
  - 微信/QQ 均通过实例内命令获取二维码。
- [x] 13. 将场景安装弹窗拆为任务设置和消息通道两步。
  - 任务字段与执行回传分步呈现。
- [x] 14. 将场景试跑改为下发后立即开始。
  - 创建后关闭配置弹窗并发送接单确认，结果稍后通过通道和最近执行查看。
- [x] 15. 国际站首版屏蔽场景任务入口，并修复弹窗可访问性和废弃代码问题。
  - 弹窗使用项目 Dialog primitive，旧等待结果组件被移除。
- [x] 16. 修复微信/QQ扫码接入命令一直 pending 时无法展示二维码的问题。
  - `debug/exec` 使用 SSE 流式读取 stdout，关闭或重试时取消旧请求。
- [x] 17. 修复 frontend 分支预览发布器拉取 master runtime 的鉴权失败。
  - 使用 CI runtime 的授权 fetch 流程，支持 SSH 或 Git WOA token fallback。
- [x] 18. 隔离 frontend 分支预览双产物构建的 Next 缓存。
  - 每个 region 构建前清理 `.next`，避免国内/国际产物复用 webpack cache。
- [x] 19. 更新 Agent 记忆页的 `MEMORY.md` 说明文案。
  - 明确持久记忆的跨会话职责。
- [x] 20. 放宽记忆统计卡片说明文案的单行展示宽度。
  - 桌面宽屏保持单行，中小屏自然换行。
- [x] 21. 移除自动任务页的场景任务卡片。
  - 国内站与国际站均不再渲染场景任务标题、说明和预设卡片；普通自动任务入口保持可用。

## 三、关键决策

### 关键实现决策

- 选择“前端场景安装器 + 复用 Hermes Cron”，避免新增后端专用调度接口；备选的 `runScenarioOnce` 接口会扩大跨服务改动，未采用。
- 将场景配置和 prompt/schedule 生成放入纯 TypeScript builder，React 组件只负责表单与状态编排，降低测试成本。
- 一次性试跑和周期任务共用同一份 draft，仅替换 name 与 schedule，避免两条创建链路漂移。
- `acli gateway qr-url --wait true` 改走 SSE 流式 `debug/exec`，以二维码 URL 首次输出为可展示时点，而不是等待命令退出。
- 场景弹窗统一使用 Radix Dialog primitive，保留焦点管理、Escape 关闭和 `aria-modal`。
- 最终按产品决策下线场景卡片，但保留底层实现和测试；相比直接删除，后续若恢复入口可以复用已验证的 builder、扫码和 Cron 创建能力。

### 技术选型理由

- **Hermes Cron：** 已具备一次性与周期调度、投递和最近执行能力，复用可维持普通自动任务兼容性。
- **SSE 流式读取：** `--wait true` 在扫码完成前不会退出，同步请求无法及时展示二维码；流式 stdout 是正确的交互边界。
- **现有 Dialog/Select 组件：** 延续 Agent 控制台的可访问性和视觉约束，没有引入新依赖。
- **构建前清理 `.next`：** 国内/国际双产物共享缓存会产生跨 region 污染，显式清理比依赖 webpack cache 命中规则更可靠。

## 四、实施摘要

- 计划列出 22 个唯一影响路径，其中包含场景模块、Cron 客户端、i18n、CI/构建脚本和记忆页。
- 关键提交：
  - `c107eb3b` 新增场景任务安装器
  - `6cc24db2` 优化场景任务试跑体验
  - `83f789bd` 修复场景任务复检问题
  - `5c34bea8` 修复扫码接入流式执行
  - `da99f6a6` 下线场景任务卡片并保留实现
- 归档日 fresh 验证：
  - `pnpm check`：通过
  - `pnpm i18n:check`：1491/1491 条英文已翻译，通过
  - `pnpm exec vitest run src/pages/marketing/scenario-tasks/__tests__/scenario-task-builder.test.ts src/lib/__tests__/hermes-cron-client.test.ts`：2 个测试文件、65 条用例通过
- `frontend/docs/` 不存在，本次无需同步独立业务文档。
- 当前归档执行分支相对 `origin/master` 无 committed diff；归档与现有未提交改动共同保留在工作区，尚未执行 commit、push 或 MR。

## 五、规范沉淀

主 Spec `frontend/openspec/specs/marketing.md` 已同步自动任务的最终状态：

- `/agents/automations` 的普通模板、任务 CRUD 和最近执行继续可用。
- 场景任务配置、builder、弹窗和测试代码保留。
- 自 2026-07-14 起，国内站与国际站均不展示场景任务卡片或可达入口。
- 二维码获取必须使用可取消的 SSE 流式 `debug/exec`。

本次没有独立 Delta Spec；最终约束直接合并到现有 `marketing` 主 Spec，避免开发期方案与最终产品状态并存造成误导。

## 六、回顾与改进

### 踩坑记录

- `acli gateway qr-url --wait true` 会持续 pending；如果等待同步命令结束才解析 stdout，用户永远看不到待扫码二维码。解决方式是流式读取并在拿到 URL 后立即渲染，同时为关闭、刷新和重试提供 AbortController。
- 国内/国际预览连续构建会复用 `.next`/webpack cache，导致第二个 region 产物失败或污染。解决方式是在每次 variant 构建前清理 Next 构建状态。
- CI checkout 的匿名 HTTP `origin` 无法稳定拉取 master runtime。解决方式是统一走 `.ci/init.sh` 提供的授权 fetch 逻辑。
- proposal/spec 描述的是初版“展示场景卡片”，但最终任务已下线入口。归档必须以最终代码和最新 plan 为准，不能把过时产品方案直接当作当前能力。
- 本次归档时当前 git 分支与 plan 记录的需求分支不同；使用显式 `scenario-task-installer` 归档名并同时记录归档执行分支，避免历史文件名被当前分支污染。

### 可复用经验

- 长时运行、会先输出关键中间结果的 CLI 应优先使用流式接口，并把取消能力作为组件生命周期的一部分。
- 自动任务的一次性试跑与周期任务应共享 draft/builder，减少 name、prompt、deliver 和 schedule 组合逻辑的重复。
- 双 region 静态构建应隔离缓存和输出目录；不能把“同一源码”误认为“可以共享所有构建中间态”。
- 产品入口下线不等于必须删除底层实现；若代码已稳定且后续可能恢复，可保留模块和测试，但主 Spec 必须明确“当前无用户可达入口”。

### 未实现 / 后续优化

- 场景任务卡片当前没有用户入口；如重新开放，必须重新走 PRD、双站范围确认、i18n 和浏览器回归，不得仅恢复一段 JSX。
- v1 未引入后端场景 metadata 或专用试跑 API；如果未来需要可靠关联试跑与周期任务，可单独评估。
- 本次没有新增依赖，也没有需要补充的破坏性迁移。
