---
id: opencraft-desktop-plugin-framework
type: task
scope: OpenCraft 云桌面插件框架；不接通或启动真实桌面。
triggers: ["云桌面插件框架", "CloudDesktopPluginAdapter", "DesktopViewController"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/plugins/cloud-desktop/src/index.tsx
  - opencraft/docs/cloud-desktop-plugin.md
status: retired
reviewed_at: 2026-10-04
review_due: 2027-01-02
revision: 1.0.0
precedence: task
derived: false
---

## goal
建立可注入后端与观看适配器的会话云桌面插件，落实入口、连接、控制与清理所有权。

## non_goals
- 不实现 WebRTC/CTL/TAT 的生产适配器，不启动桌面，不重启或替换预览，不提交推送。
- 不修改先前的 TencentOS/Ubuntu 安装行为，不使用 Codex 私有服务或凭据。

## requirement_refs / requirement_excerpt
requirement_ids：本会话桌面插件框架请求（外部 Issue/TAPD 编号 unknown）。
用户：先把插件的整个框架搭建起来是不是可以？此前要求参考本机 Codex 的桌面建模。

## interface_refs / data_structure_refs
- WorkbenchPanelService / PanelRendererProps：现有声明式面板、会话 owner 与视图 presentation 分离。
- DesktopBackend / DesktopAttachment / DesktopConnection：身份解析、短期观看租约与远端资源分离。
- DesktopControlLease：服务端授权及撤销；未授权不得绑定输入。

## history_context
- current_design_refs：opencraft/docs/platform-architecture.md、opencraft/docs/plugin-architecture.md、opencraft/design/invariants.md。
- relevant_evolution：基线 bbd7ffb83；同工作树已有 TencentOS 安装适配与本机安装记录，保持不变。
- superseded_refs：旧 frontend 云桌面组件只作背景，不作为 OpenCraft 状态/权限所有权实现。
- Codex 26.930.31428 本机只读分析：每会话一个标签，视图释放不停止远端，观看与控制分离；不复制私有 UID/端点，亦不声称其客户端拥有完善重连。

## acceptance
- 未配置真实适配器时不暴露可用入口；相同会话重复打开只聚焦同一标签。
- 两项观看就绪条件均成立才可控制；确认授权之前无输入，迟到授权必须释放。
- 目标/账户变化、关闭、卸载后旧结果不得覆盖新连接；释放观看租约不停止桌面或 Agent。
- 聚焦模型/插件及真实 React 组件测试、受影响包类型检查、平台边界检查。

## affected_paths
opencraft/plugins/cloud-desktop、Workbench 应用组装、面板图标、locale、设计文档、测试与 workspace lock。

## required_context / context_receipt
| 文件（bbd7ffb83 基线） | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、opencraft/AGENTS.md | 本地维护规则 | 隔离工作树、授权和验证边界 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md、references/verification.md | 所有权维护 | 不以模拟替代实机；清理和迟到结果优先 |
| opencraft/docs/platform-architecture.md、docs/plugin-architecture.md | 应用与插件职责 | 复用内建 Cordis 注册，不扩展公共插件 ABI |
| opencraft/design/README.md、design/invariants.md | 工作区约束 | 右侧工具、稳定会话、无未接通能力 |
| WorkbenchPanelService、workbench-panels-react、terminal plugin、web-workbench-application | 真实消费者 | 自注册及逆序卸载 |
| .agents/context/change-impact.json、Domain/Journey | 文档影响 | 同步正式架构说明 |

## evidence
- context router 无匹配 pack，改为在上述精确路径有界读取。
- 当前预览不修改；新工作树无 node_modules，使用本树依赖验证。
- 本树 `npm install --ignore-scripts --no-audit --no-fund`，lock 仅新增插件 workspace 与应用依赖，不借用其它 checkout 依赖。
- `node --import tsx --test tests/cloud-desktop-plugin.test.tsx tests/workbench-panels.test.ts`：最终 33/33（桌面 17、原面板 16）；包括真实 React 组件、等待授权、内部焦点转移、window blur、逻辑关闭先于卸载。
- 受影响两 workspace typecheck、check:i18n（186 messages）、check:boundaries、build:web：exit 0。Web 构建仍有既有 chunk-size / dynamic-import 警告；产物仅在本树，不发布。
- `npm run gate`：已通过全 workspace typecheck、国际化、边界与 Electron launch；在 `pretest:extensions` 的既有 `extension-artifacts.test.ts:38` 失败（更新回滚记录多了 artifactRef）。该测试及被测扩展持久化源码无 diff。失败后测试未自行退出，仅终止本轮验证 worker 4152369；未终止预览或宿主。
- 正式文档 validator 与 docs-impact：exit 0；全仓 context validator 仍有既有历史任务字段/期限问题，新 Task Pack 触发词已修正，不为此改无关历史。
- `git diff --check`：exit 0。预览 `opencraft-neutral-focus-20261004-preview.service` 仍 active、MainPID 2785955，未重启/替换。

## risks
- 后端必须拥有权限/独占控制，客户端租约不是安全隔离本身。
- 本轮不验证编码、网络穿透、真实控制撤销、手机输入及运行中恢复。

## validation
上述源码/组件、类型、构建与边界证据已验证；完整门禁没有通过，保留既有失败。真实桌面、媒体、鉴权/控制服务、手机输入均未验证。

## decisions
- 插件只消费当前会话的权威目标解析端口，不将 legacy hostId 当资源或账户身份。
- 远端桌面没有 stop 接口暴露给视图；关闭只释放短期观看与控制。
- 测试替身仅放测试文件，生产无模拟能力。

## scan_scope / scan_output
仅 OpenCraft 面板、插件、应用组装与上述文档；无全仓参考扫描。

## handoff
框架实施完成、源码未提交。通过 `CreateWebWorkbenchApplicationOptions.cloudDesktop` 接入真实后端/媒体适配器后才发布可用入口。
下一阶段先补齐 CTL/TAT 资源代次与短期 attachment、后端独占输入，再接媒体；当前图形环境安装不能代替这些契约。

## checkpoint
- stage：源框架及有限验收完成，生产适配器待实施。
- verified：插件自注册、单会话单标签、观看/控制分离、异步代次与撤销/清理；33 项聚焦测试与 Web build。
- unverified：真实信令/ICE/媒体、后端授权/Agent 仲裁、触控输入、自动网络恢复及发布。
- discard：不复制 Codex 私有后端/UID，不借用旧 frontend viewOnly 作为控制安全边界。
- restore：本隔离工作树 bbd7ffb83 加当前未提交改动，先前 TencentOS 安装改动保留；现有预览不变。
- next_action：按 `opencraft/docs/cloud-desktop-plugin.md` 的 production adapter requirements 设计并验证后端接入。
