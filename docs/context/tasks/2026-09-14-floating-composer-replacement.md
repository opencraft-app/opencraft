---
id: floating-composer-replacement
type: task
scope: Codex 浮动聊天的所有权、呈现及交互替换
triggers: [opencraft, floating-composer]
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/design/invariants.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

# Codex 浮动聊天整体替换

## goal
整体替换简化的 ThreadComposerPresentation，迁移 Codex 浮层的所有权、呈现及交互契约。

## non_goals
- 不新增会话、草稿或浏览器资源 owner；不增加下方面板；不改模型配置、不提交、不发布生产。

## requirement_refs
- 用户确认：“严格按照Codex实现复刻，整体替换。”

## history_context
- 当前设计：opencraft/design/workspace-model.md、invariants.md。
- 参考：ref/codex r3589；安装包 26.908.40834 的 right-panel-composer-overlay-f770dcfd060a.js 和 right-panel-composer-overlay-c2ae7a9bcecb.css。
- 明确区分恢复树、安装包和适配层，不能将重命名的端口实现声称为逐字复制的私有宿主源码。

## interface_refs / data_structure_refs
- 接口：ThreadComposerPresentation、ComposerController、BrowserSurfaceHost、BrowserPageSnapshot。
- 不变量：路由级显隐意图、标签级收起原因、四阶段显隐、焦点派生密度、独立最近轮次预览和唤回宿主。

## acceptance
- 草稿和已有会话均只有一个交互输入；收起/唤回保留编辑器 DOM、草稿和浏览器。
- 验证紧凑、聚焦展开、最近回复、收起、唤回、菜单焦点、手势惯性、打断和减少动态效果。
- 收起把手不占正常内容高度；入口支持键盘。
- 运行聚焦测试、完整门禁和独立安装包的原生验证。

## affected_paths
- 浮层：opencraft/apps/workbench-web/src/components/thread-composer*、floating-composer-state.ts。
- 宿主：BrowserSurfaceHost、ElectronBrowserSurfaceHost、browser-guests、preload、Main。
- 集成：AppShell、NewThreadDraftPage、ConversationTurn、主题 token、测试及设计文档。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、opencraft/AGENTS.md | 仓库约束 | 有界变更和隔离验证 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md、references/verification.md | 维护规范 | 所有权和原生验证 |
| opencraft/design/README.md、workspace-model.md、invariants.md | 当前设计 | 保持右侧工具和既有服务 |
| .agents/skills/baseline-ui/SKILL.md、fixing-motion-performance/SKILL.md、fixing-accessibility/SKILL.md | 控件及动画 | 主题、取消和焦点 |
| docs/engineering/domains/agent-gateway-runtime.md | 正式设计映射 | 同步跨域不变量 |

## decisions
- 用户明确要求源实现复刻，因此采用 Codex 有界的 max-width/max-height 动画，而不是泛用的仅 transform 建议。
- Main 只追踪已登记的 guest；不赋予网页 Node 或主应用 preload 权限。
- 保持同一 portal destination，通过移动实际容器切换位置；Portal 子树的焦点事件用 DOM 适配器接入。
- 窗口是否激活由 Main 判断：guest 获得焦点不等于 macOS 窗口失焦。

## evidence
- 路由器无匹配；有界搜索定位现有浮层、宿主、参考状态、手势和预览。
- 原生测试第一次通过：/tmp/oc-floating-kk422o，验证草稿、编辑器 DOM、WebContents 和 guest 鼠标。
- 增强原生矩阵通过：/tmp/oc-floating-plHjW0，包含菜单、标签返回、快速反向、网页失焦和撤销。
- 实际 Web 长回复预览、主题和键盘通过：/tmp/opencraft-workspace-presentation；默认减少动态效果和普通动画各运行一次。
- 状态与惯性测试 7 项通过：/tmp/overlay-final-state.log。
- 多轮完整门禁通过，最终记录待汇总；文件为 /tmp/overlay-complete-gate.log。

## risks
- 共享工作树有大量其他任务的未提交修改，保持原样。
- 标准 Web 跨域 iframe 无法读取 guest 鼠标事件，保留工具栏和键盘入口；同源 Web 及桌面分别使用各自端口。
- 仓库级 context 检查发现已有历史文档/指令链问题，不扩大本次任务处理范围。

## validation
- OpenCraft 完整门禁通过：/tmp/overlay-complete-gate.log；随后最终 Web/Electron 类型检查和 230 项 Workbench 单测通过，见 /tmp/overlay-final-types.log、overlay-final-unit.log。
- 最终独立安装包签名严格检查通过，真实原生矩阵通过：/tmp/overlay-packaged-smoke.log、/tmp/oc-floating-YCqHFm。包括草稿、DOM、WebContents、菜单、标签返回、底边鼠标、键盘、快速反向及撤销。
- 预览产物：opencraft/apps/workbench-electron/release/codex-floating-composer-verified-preview/mac-arm64/OpenCraft Preview.app。已独立打开并定位到浏览器最大化的浮动输入。
- 文档校验通过；staged 影响检查因未暂存变更仅为空集检查，不作为语义完成证据。
- 全仓 context 测试首次有 4 项失败（含本 Task Pack 当时缺少元数据与英文段落，现已补齐并改为中文）；其余指令链长度与历史文档凭据候选不在本次范围。context-audit 的 33 项测试通过。

## checkpoint
### stage
最终安装包验收和交接。

### verified
- 浏览器底边追踪使用真实 Main mouse event。
- 最近轮次预览不重复用户 intro，使用独立滚动区。
- 标签返回回归发现并修正：readiness 改变导致唤回宿主重新挂载时，必须重新测量锚点。
- 原生菜单/切标签/网页焦点/键盘/撤销均通过。

### unverified
- 标准 Web 跨域 iframe 的鼠标读取受浏览器隔离限制，不冒充桌面原生追踪；已保留键盘与工具栏入口。

### discard
- /tmp/overlay-web.log、web2 是冷启动及测试夹具缺少根渲染器 Provider 的失败，不作为生产故障结论。
- 标签切换首次失败命中了 role=presentation 外壳；后续使用真实 role=tab 按钮。

### restore
- 运行时测试使用合成 HTTP 页面、隔离 profile 与模型目录；不复制真实凭据或会话。

### next_action
- 验证 release/codex-floating-composer-verified-preview，打开独立预览。

## handoff
代码替换、OpenCraft 门禁、真实组件及最终原生包验证已完成，新预览已打开。没有提交代码或发布生产；全仓 context 存量问题另列，不声称全仓检查全绿。
