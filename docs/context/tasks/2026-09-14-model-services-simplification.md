---
id: model-services-simplification
type: task
scope: 将用户确认的简化模型服务示意落地到 OpenCraft
triggers:
  - opencraft
  - model-services
  - simplified-ui
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/local-agent-custom-providers.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.1
precedence: task
derived: false
---

# 模型服务简化

## requirement_ids

- simplified-model-services

## requirement_refs

- 当前用户批准简化版 LobeChat 交互示意后要求实施。

## requirement_excerpt

“挺好的，这个设计好。”、“搞起来。”

## goal / non_goals

保留环境导航及提供商层级，按需展开连接，精简模型行和重复分类。不替换配置存储、凭据服务、路由或默认模型策略，不提交发布。

## history_context

已删除的旧模型设置页面不恢复；沿用现有 model-services 控制器、品牌标识和共享控件。明确保存/取消取代该表单自动保存，检查仍沿用先提交草稿的已存在行为。

## context_receipt

- opencraft/AGENTS.md
- opencraft/.agents/skills/opencraft-maintenance/SKILL.md
- opencraft/.agents/skills/opencraft-maintenance/references/verification.md
- .agents/skills/baseline-ui/SKILL.md
- .agents/skills/fixing-accessibility/SKILL.md
- opencraft/docs/local-agent-custom-providers.md
- opencraft/docs/platform-architecture.md
- opencraft/docs/build-matrix.md
- docs/context/project/adjacency/frontend-runtime-openspec-i18n.md（无 OpenCraft 专用邻接，核对本服务 model-services.test.ts 与 smoke-model-services.ts）

路由 opencraft 无匹配；有界搜索 model-services/view.tsx 和 EnvironmentNavigation 定位当前实现。

## acceptance / validation

验证已配置折叠、首次展开、脏草稿切换/重挂载、取消无写入、明确保存、Radix 更多操作、主题和窄屏。运行聚焦测试、完整 gate、隔离 DSH UI smoke 与独立 Mac 预览。

## checkpoint

后续请求：“Responses API 可以折叠到高级吧？”、“搞”。已增加默认折叠的高级设置，协议已启用时保留摘要，折叠不更改值。仅提供商声明支持才呈现。新增真实组件回归覆盖展开、开关、折叠后保留协议、取消。类型检查、聚焦测试、完整 gate 和隔离 UI smoke 通过；测试等待凭据检查稳定后继续取消流程。新产物 `opencraft/apps/workbench-electron/release/models-advanced-preview/mac-arm64/OpenCraft Preview.app` 构建、打包和签名校验通过，实机 Azure 提供商确认高级默认关闭、开关不可见，展开可操作后再收起；截图 `/tmp/opencraft-models-advanced-native.png`。没有写入真实凭据或修改协议。

阶段：实现与验收完成。聚焦 model-services 7 项测试通过，覆盖已配置/未知/缺少凭据、显式收起优先、脏草稿保留和取消无写入。完整 npm run gate 通过；实机发现的首次收起优先级修正后，再次通过聚焦测试、build:electron 和真实组件 smoke。后者覆盖明确保存/取消、更多操作、检查、导入、默认切换、主题、窄屏与重挂载，使用隔离 DSH/本地合成模型端点，没有外部付费推理请求。

Mac arm64 最终产物：`opencraft/apps/workbench-electron/release/models-simplified-final-preview/mac-arm64/OpenCraft Preview.app`。打包与 codesign 深度校验通过；新独立窗口验证紧凑环境导航、概览往返、首次展开、手动收起/重新编辑，停留在模型服务收起状态。截图 `/tmp/opencraft-models-simple-final-native.png`。独立预览没有复制用户凭据，未配置提示属实。

文档校验 errors=[]，git diff --check 通过；staged 影响检查因暂存集为空仅作记录。不恢复旧模型面板、不改变用户配置；未提交、推送、发布或验证其他原生平台。下一步由用户验收最终预览视觉与编辑流程。
