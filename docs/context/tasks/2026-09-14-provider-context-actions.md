---
id: provider-context-actions
type: task
scope: 给 OpenCraft 自定义提供商添加安全的右键重命名与删除
triggers:
  - opencraft
  - provider-delete
  - provider-rename
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

# 自定义提供商操作

## requirement_ids

- provider-context-actions

## requirement_refs

- 用户截图中自定义提供商列表的右键操作请求。

## requirement_excerpt

“右键允许删除，以及重命名。”

## goal / non_goals

自定义提供商右键菜单与确认窗口；重命名不换身份，删除有默认保护、CAS 和共享凭据保护。不允许删除内置适配器，不清除真实用户实例，不提交发布。

## history_context

现有 apply 支持 displayName，没有提供商删除命令。新增 Host 删除协调命令沿用 DSH settings.mutate，不由 UI 操纵底层设置。沿用现有模型服务、Radix 控件和主题。

## context_receipt

- opencraft/AGENTS.md
- opencraft/.agents/skills/opencraft-maintenance/SKILL.md
- opencraft/docs/local-agent-custom-providers.md
- opencraft/docs/build-matrix.md
- .agents/skills/baseline-ui/SKILL.md
- .agents/skills/fixing-accessibility/SKILL.md

路由 opencraft provider rename delete 无匹配；精确搜索 service/provider methods 后检查 runtime-provider-service.test.ts 和 smoke-model-services.ts。

## acceptance / validation

主机测试：自定义限定、默认保护、revision 冲突、只读、精确路径、凭据无写入。真实组件与隔离 DSH：右键重命名、取消删除、确认删除、选中项恢复及真实目录删除。运行类型检查、gate 和独立 Mac 包。

## checkpoint

后续用户先要求列表 checkbox，随后明确改为截图中的滑动开关。最终复用共享 SettingsSwitch，不保留新增的 SettingsCheckbox 组件或样式；开关与名称按钮独立，默认提供商只读保护。右键移除启停，宽屏不重复直接启用按钮，窄屏保留替代入口。类型检查、完整 gate、隔离 DSH smoke、Electron 构建与打包通过。最终产物 `opencraft/apps/workbench-electron/release/provider-list-switch-preview/mac-arm64/OpenCraft Preview.app` 已校验签名并打开；实机目标行 role=switch 为 1、列表原生 checkbox 为 0，截图 `/tmp/opencraft-provider-list-switch-native.png`。用户看到旧 checkbox 时最终包尚未打开，已明确区分旧窗口与新产物；未改变用户启用配置。

后续用户批准启用/停用放入列表右键菜单，并在未启用详情保留直接入口。已接入支持 canToggle 的内置与自定义提供商，保留自定义专属重命名/删除；状态摘要明确区分配置与启用。沿用同一 toggle 命令及默认保护。30 项聚焦测试、额外状态投影回归、隔离 DSH UI smoke 和完整 gate 通过。新包 `opencraft/apps/workbench-electron/release/provider-toggle-preview/mac-arm64/OpenCraft Preview.app` 构建、打包与签名校验通过；实机验证内置右键停用但无删除、自定义右键启用和详情直接按钮。专用测试条目已删除，未启停用户已有连接。截图 `/tmp/opencraft-provider-toggle-menu.png`。未提交或发布。

阶段：实现与验收完成。30 项聚焦测试、完整 npm run gate、隔离 DSH 的 smoke:model-services 通过。真实链路覆盖重命名、取消删除、删除选中连接后的目录与选择恢复；主机用例覆盖默认保护、内置保护、只读、精确路径、CAS 与凭据不变。

Mac 产物 `opencraft/apps/workbench-electron/release/provider-context-actions-preview/mac-arm64/OpenCraft Preview.app` 构建、打包和 codesign 深度校验通过；新窗口实测创建专用测试连接、右键重命名及删除，测试连接已移除，其他已有条目未动。截图 `/tmp/opencraft-provider-context-menu.png`。未使用真实密钥或外部推理。

Radix 依赖显式绑定项目当前 React DOM 19.2.3，避免 npm 自动选择不兼容的 React DOM 19.3。文档校验 errors=[]，git diff --check 通过；staged 影响检查因空暂存集仅作记录。未提交、推送、发布；其他原生平台未实测。下一步由用户验收自定义提供商右键入口。
