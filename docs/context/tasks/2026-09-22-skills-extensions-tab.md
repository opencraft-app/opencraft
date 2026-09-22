## goal
将扩展管理放入 Skills 新增的“扩展”Tab，统一展示内建与用户安装扩展及详情。

## non_goals
- 不建设 Marketplace；不更改站点 Skills 目录、生成的 upstream 或 Host 技能安装协议。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户：放在 Skill 下面，多一个 Tab，叫做扩展。

## interface_refs / data_structure_refs
- PlatformViewRegions.ExtensionLibrary：应用提供内容，Hermes Skills 只拥有 Tab 选择。
- Supervisor + Manager + ContributionStore 派生只读目录；操作仍由 Manager 拥有。

## acceptance
- Skills 增加扩展 Tab；不显示 Host 安装目标，切换不重建运行时。
- 普通模式可搜索/筛选内建和用户扩展、查看详情；仅用户安装项提供实际支持的启停/更新/卸载；URL 安装仅开发者模式。
- 行级 pending/error；复用现有 UI 控件与主题。
- 类型检查、目录模型测试与真实组件/Tab 浏览器验收。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| docs/context/project/services/frontend.md | Router must_read | 确认当前只改 OpenCraft |
| opencraft/AGENTS.md | 局部规则 | 不编辑生成 upstream |
| .agents/skills/product-skills/lv-sitepage-skills/SKILL.md | Skills 维护 | 目标为 OpenCraft，非国内/国际站目录 |
| .agents/skills/baseline-ui/SKILL.md | 控件一致性 | 复用 Settings primitives |

## validation
- extension runtime/react、Hermes plugin、Workbench Web typecheck；聚焦测试；浏览器验收；文档影响检查。

## handoff
- 完整 npm run gate 成功退出 0（/tmp/opencraft-skills-extensions-gate.log），包括 Web、Expo Web/iOS 构建；Electron 独立构建通过。新增浏览器 480px 检查无横向溢出，普通模式安装门禁和确认移除通过。未提交、打包或替换用户已安装应用。
- 已实现 Skills 扩展 Tab、宿主内容槽、统一只读目录、列表/详情/来源筛选、行级操作与移除确认；普通模式可管理，开发者模式才有 URL 安装；Settings 导航不再显示插件入口，旧路由保留兼容。
- Electron smoke 通过：真实 Skills Tab/ExtensionLibrary、安装、详情、搜索保留、Host 选择器隐藏、启停、开发者门禁、取消/确认移除、内建保护。截图 /tmp/opencraft-skills-extensions.png。
- extension-react/runtime、Workbench Web、Hermes plugin 类型检查与边界检查通过；Electron 构建通过。
- lightvela-work-navigation 历史静态断言中 Start 字面量和旧 DSH Skill roots 源码路径仍有漂移；本次不改 DSH 根路径逻辑。新增扩展目录模型测试通过。
