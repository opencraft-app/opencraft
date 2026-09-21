---
id: model-brand-icons
type: task
scope: 为 OpenCraft 模型服务提供统一的品牌图标呈现
triggers:
  - opencraft
  - model-icons
  - provider-icons
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/local-agent-custom-providers.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

# 模型服务品牌标识

## requirement_ids

- model-brand-icons

## requirement_refs

- 当前用户对话：参考 LobeHub/LobeChat 后批准加入图标。

## requirement_excerpt

“全部模型的列表一个图标都没有太难看……好的，改起来。”

## goal / non_goals

提供商列表、标题与模型行显示统一品牌标识，主题兼容、固定占位、未知兜底。不改变配置、路由、默认模型及用户数据，不提交或发布。

## history_context

保留已确认的新模型服务页面，不恢复两版已删除的模型设置 UI。参考本地 LobeHub 源码的品牌与模型分离方式，资源使用独立静态 SVG 包，不引入完整 UI 框架。

## context_receipt

- docs/context/domains/agent-gateway-runtime.md
- opencraft/AGENTS.md
- opencraft/.agents/skills/opencraft-maintenance/SKILL.md
- opencraft/.agents/skills/opencraft-maintenance/references/verification.md
- .agents/skills/better-icons/SKILL.md
- opencraft/docs/local-agent-custom-providers.md

## acceptance / validation

精确提供商别名、跨网关模型家族、未知和缺失资源回退单测；真实组件验证固定尺寸、浅深主题与窄屏；完整门禁和桌面产物按证据记录。

## checkpoint

阶段：实现与验收完成。品牌映射 3 项单测、提供商插件类型检查、完整 npm run gate、真实组件 smoke:model-services 均通过；后者使用隔离 DSH 与本地合成模型服务，无外部推理请求。浅色、深色与窄屏检查通过，主题测试改为调用应用真实主题入口。文档检查 errors=[]，git diff --check 通过；staged 影响检查因暂存集为空仅作记录。

桌面 build:electron、Mac arm64 打包及 codesign 校验通过。独立预览 `opencraft/apps/workbench-electron/release/model-brand-preview/mac-arm64/OpenCraft Preview.app` 已打开到本机模型服务；实际窗口检测 42 个品牌槽位及 3 个模型图标，截图 `/tmp/opencraft-model-brand-desktop.png`。用户账户、凭据与既有窗口未迁移或修改。

未验证：其他桌面平台原生运行；未提交、推送或发布。恢复入口为品牌呈现组件及本文件，不恢复已删除的模型设置页面。下一步由用户检查视觉效果；默认模型策略不是本轮范围。
