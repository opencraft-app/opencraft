## goal
移除 OpenCraft 浏览器标题栏中冗余的 Vela/Home 按钮，不留下空白占位，也不丢失侧栏收起时的新任务入口；用户随后明确要求替换当前本机预览服务。

## non_goals
- 不改变 Router 目的地、侧栏 Start、Electron 既有标题栏动作；不触及生产、GitOps、云资源或外部服务。

## requirement_ids / requirement_refs / requirement_excerpt
- 本次会话的用户要求：“删除这个home按钮吧 目前来看意义不大。”无外部需求编号。

## interface_refs / data_structure_refs
- `apps/workbench-web/src/window-chrome.ts`：`HeaderNavigationAction`、浏览器/Electron 策略与首帧按钮轨道宽度。
- `apps/workbench-web/src/components/app-shell-header.tsx`：持久/临时标题栏的动作投影与测量副本。
- 不变量：物理 Header 只有一个 owner；持久侧栏收起时仍有新任务入口，测量轨道与可见轨道一致。

## history_context
- `current_design_refs`：`opencraft/docs/platform-architecture.md` 的 Header/Router 段落，以及 `opencraft/design/invariants.md` WSP-17/18/25。
- `relevant_evolution`：浏览器 Home 原先是共享标题栏中的文字标识；Electron 已没有该按钮。现有浏览器策略不按视口宽度变化。
- `superseded_refs`：无。

## acceptance
- 任何视口宽度的浏览器 Header 都没有 Vela/Home 按钮及其保留宽度。
- 浏览器和 Electron 的持久 Header 在侧栏收起时显示 Write；浮动/临时 Header 不复制 Write。
- 标题栏聚焦测试、Web 类型检查及适当的视觉/运行态检查通过。

## affected_paths
- `opencraft/apps/workbench-web/src/{window-chrome.ts,components/app-shell-header.tsx,styles/app.scss,i18n/locales/zh-CN.json}`
- `opencraft/tests/workbench-window-chrome.test.ts`
- `opencraft/docs/platform-architecture.md`、`opencraft/design/invariants.md`
- `.agents/context/change-impact.json`：把本次纯呈现文件从无关的 Agent Gateway 运行时影响规则中精确排除。

## required_context
- Context Router 查询 `OpenCraft remove browser app shell Home Vela button navigation chrome responsive layout` 因泛化的 navigation/layout 词命中 `frontend-product-surface`；该服务实际对应 `frontend/`，不是 OpenCraft。本任务以 OpenCraft 的局部规则和设计为准。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 根规则 | 明确范围、Task Pack 与验证门禁 |
| `opencraft/AGENTS.md@working-tree` | 局部规则 | 标题栏/导航不变量与视觉验收 |
| `docs/context/project/services/frontend.md@working-tree` | Router 必读 | 确认泛词误命中 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 维护 Skill | 保留平台所有权与可验证体验 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 视觉验证入口 | 选择聚焦测试和浏览器检查 |
| `opencraft/design/README.md@working-tree` | 设计入口 | 同步窗口导航不变量 |
| `opencraft/design/invariants.md@working-tree` | WSP-17/18/25 | 保留新任务入口 |
| `opencraft/docs/platform-architecture.md@working-tree` | 正式设计 | 删除失效的 Vela/Home 描述 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 最近的前端邻接卡 | 确认泛词匹配；实际邻居是 OpenCraft 标题栏测试 |

## evidence
- 有界检索确认浏览器的 `leadingNavigationActions` 原先包含 `home`，Electron 没有；共享 Header 和测量副本都呈现 Vela 文字。`tests/workbench-window-chrome.test.ts` 覆盖首帧宽度和动作集合。
- 改动后独立 Web 构建的 buildId 为 `20260925093654-42b07aa19255`；静态预览的 `/version.json` 返回该版本。OpenCraft 浏览器工具能打开页面，但 `inspect` 返回 `PREVIEW_BRIDGE_UNAVAILABLE`，截图仅支持桌面浏览器，因此未完成手机 DOM 检查；预览页和临时静态服务已关闭。

## risks
- 移除浏览器 Home 后，既有的侧栏收起态 Write 投影会显示出来；必须同时修正首帧宽度，避免布局漂移。
- 当前运行中的服务仍是上一版；源码构建不等于用户手机页面已更新。

## validation
- `tests/workbench-window-chrome.test.ts` 14/14、相邻导航/时间线测试 72/72 通过。
- Web workspace 类型检查、`npm run build:web`、`check:i18n`、`check:boundaries`、文档校验、显式变更影响检查及 `git diff --check` 通过。
- 仓库级 Context 测试仍有四项治理基线失败：多份旧 Task Pack 缺字段、当前 instruction chain 超预算、secret-literal 扫描已有命中及英文优先文档等；本 Task Pack 已改为中文优先。手机真实 DOM 与触控验收未完成。

## decisions
- 从浏览器 chrome 策略和动作类型中删除 Home，不只用 CSS 隐藏文字。侧栏 Start 与收起后的持久 Write 继续承担新任务导航。
- Agent Gateway 影响规则对这次纯 Header 呈现改动误命中；仅排除本次涉及的呈现文件。OpenCraft 平台/设计文档仍是该行为的语义权威。

## scan_scope
- `opencraft/apps/workbench-web/src/{window-chrome.ts,components/app-shell-header.tsx,styles/app.scss}` 与 `opencraft/tests/workbench-window-chrome.test.ts`。

## scan_output
- 对 `app-shell-home-button`、`data-app-shell-home-trigger`、`leadingNavigationActions` 和 `getHeaderStartMinimumWidth` 做精确扫描，只命中共享 Header、chrome 策略、聚焦测试及架构文档。

## handoff
- 源码与独立 Web 构建已完成。用户本次追加“替吧”，明确授权替换当前 `/opt/opencraft-server/current` 指向的本机预览服务；当前 buildId 为 `20260925085957-b542a257994f`，数据根保持 `/var/lib/opencraft-preview-codex-20260923173651`。新 Headless 归档、实包烟测、切换与运行态核验待完成。

## 2026-09-25 本机预览替换续作
- Context Router 查询 `OpenCraft headless local preview replace current service after browser Home removal` 无匹配；有界检索按 `headless-linux-amd64-tar` 定位构建矩阵、打包脚本和归档烟测。重读 OpenCraft 维护 Skill 与验证清单；本轮只处理本机预览替换。
- 当前服务是 `opencraft-server.service`，运行 release `20260925085957-b542a257994f`，健康端点与 `/version.json` 一致。将新包安装为独立 release，先完成烟测，再延时原子切换 symlink、重启并用健康与 buildId 核验；失败自动回滚。
- 新归档 `/data/opencraft-home-removal-release-eK3n1y/OpenCraft-server-no-home-linux-amd64.tar.gz` 构建和实包烟测通过，buildId `20260925094935-96fce7adcca3`，归档 SHA-256 `f94945a44a9a201adff6a28812234590d01f89177541ed8c26285e549288b863`。实包烟测覆盖清单、WebUI、DSH 和 Codex AppHost 初始化。新 release 已解压到 `/opt/opencraft-server/releases/20260925094935-96fce7adcca3`；包内与安装后的 `runtime/server.mjs` 哈希一致。当前 symlink 尚未切换。
- 切换脚本 `/data/opencraft-home-removal-release-eK3n1y/switch-release.sh` 明确预期旧/新路径，用 `current.next` 原子更新 symlink，重启后核对健康端点与 buildId；失败则恢复旧 symlink 并重启。应在本条助手回复完成后才触发，避免中断承载当前对话的服务。
- 旧包 Web 资源包含 `data-app-shell-home-trigger`，新包 Web 资源没有；脚本语法及工作树差异检查通过。systemd 延时任务 `opencraft-no-home-switch.timer` 已排定于北京时间 17:54:54 触发。此处仅能报告“切换已排定”；脚本自己的健康检查结果须在触发后确认，不提前宣称正在运行的版本已更新。
