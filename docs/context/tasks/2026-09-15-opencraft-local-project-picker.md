---
id: opencraft-local-project-picker-20260915
type: task
scope: 本机工作目录选择与 OpenCraft 项目持久化。
triggers: ["opencraft", "local project picker", "workspace folder"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/local-agent-host/src/project-repository.ts
  - opencraft/docs/platform-architecture.md
status: retired
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
让本机 Electron 的“添加项目”可用，保留 Host 隔离的执行路径和持久化项目身份。

## non_goals
不使用引擎拥有的产品目录，不在远端调用 Finder，不修改模型，不提交、推送或部署生产。

## requirement_ids / requirement_refs / requirement_excerpt
当前用户批准：“实现吧”；已确认本机使用系统目录选择器，OpenCraft 拥有项目目录。

## interface_refs / data_structure_refs
接口为 `ProjectCreateParams`、`Project`、Electron 可信 renderer 边界和草稿执行 `hostId/workspace`。
不变量：目录只有一个 owner；取消不修改状态；迟到结果不得修改替换后的草稿或 Host。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md`。
- relevant_evolution：本机添加入口原先禁用，DSH 未实现 `project/create`。
- superseded_refs：引擎 `workspace.list` 投影不再作为产品权威。

## acceptance
本机打开系统对话框；添加与选择产生稳定的 `projectId` 和 `cwd/roots`；重复选择复用身份；重启保留目录；远端/Web 保留文件系统选择器；取消和迟到结果安全。

## affected_paths
影响路径：`opencraft/apps/local-agent-host`、`opencraft/apps/workbench-electron`、`opencraft/apps/workbench-web`、测试和平台架构。

## required_context
路由未匹配；已在受影响应用中进行有界精确搜索。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | 服务边界 | 门禁和平台所有权 |
| opencraft/docs/platform-architecture.md | 当前设计 | Host 和 renderer 所有权 |
| docs/context/tasks/TASK-TEMPLATE.md | 任务契约 | 范围和证据 |
| docs/context/tasks/CHECKPOINT-TEMPLATE.md | 恢复 | 检查点 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 可用 UI 邻接 | 检查服务测试邻居，不改上游 |

## evidence
源码证据：`workspaceBrowseRoots` 为空；添加入口受限；DSH 仅实现项目列表。
聚焦 `npm run test:projects`：13/13；本机 Host/Electron/Web 类型检查通过。
最终完整 `npm run gate` 通过。
签名包 `release/project-picker-20260915-final` 通过真实 Electron 冒烟；对话框返回值使用替身，覆盖取消、创建/选择、重复身份、迟到结果隔离及应用重启。
已确认真实系统对话框被调用打开，但 CUA 无法连接，未验证真实点击取消。
文档校验和明确变更文件的影响门禁通过；全仓 Context 门禁仍有历史任务格式和长度/扫描问题，另行记录，不扩展本次范围。

## risks
风险为导航后的异步结果、重复写入和损坏存储；通过身份隔离和加锁原子写入缓解，损坏文件拒绝覆盖。

## validation
验证为聚焦测试、服务类型检查、`npm run gate`、实际 Electron 入口和取消边界。

## decisions
系统选择器归属 Electron Main；产品目录归属 OpenCraft Host，而非 DSH。

## scan_scope
仅扫描受影响应用源码和测试。

## scan_output
无匹配路由；精确符号搜索定位了当前接入。

## handoff
实现完成；独立预览已打开；保留上一轮未提交的提供商默认菜单改动；本轮未提交或推送。

## checkpoint
- stage：完成交接。
- verified：产品仓库和系统选择器已实现；最终签名桌面冒烟、聚焦测试和完整门禁通过。
- unverified：真实系统取消点击及远端/Web 交互端到端；原有文件系统模型测试保留并通过。
- discard：失败的长 profile 测试及连接前的选择时序。
- restore：最终预览 `release/project-picker-20260915-final`、CDP 19824。
- next_action：用户在新预览选择自己的项目目录。
