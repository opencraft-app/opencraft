# 修复系统预置 Skills 来源误标

## 需求

- 背景：国内站 `/agents/skills` 的“已安装”列表把随 Hermes 镜像提供的 bundled Skills 显示为 `SkillHub`，并错误展示删除按钮。
- 目标：系统预置 Skill 必须显示“系统预置”，且不可删除；真正通过 SkillHub 安装的 Skill 保持 `SkillHub` 来源和现有卸载能力。
- 成功标准：SkillHub/ACLI 列表返回 `source: builtin` 时能保留该语义；Hermes 权威清单将匹配项判定为 `builtin` 时，合并结果覆盖市场来源展示与卸载能力。

## 方案

- 在 `skill-registries.ts` 中保留 SkillHub installed item/instance 的 `source` 字段，只对明确的 `builtin` 赋予系统预置语义。
- 在 SkillHub 与 Hermes 清单合并时，让 Hermes `builtin` 成为最终来源与卸载能力的权威；其他 marketplace 合并行为不变。
- Installed 来源展示优先识别 `nativeSource: builtin`，不再因为记录同时带有 `skillhub` registry 而显示 SkillHub 徽标。
- 范围仅限已安装技能来源归并与对应测试；不改搜索、安装命令、普通 SkillHub 卸载、国际站 registry 规则、图片、文案或发布配置。

## 关键上下文发现

- `images/build.sh` 明确将截图中的 `architecture-diagram`、`arxiv`、`hermes-agent`、`maps`、`powerpoint` 等保留在 Hermes bundled skills 中。
- `frontend/src/lib/hermes-skills-client.ts` 已能通过 Hermes `Source=builtin` 或 `.bundled_manifest` 识别预置 Skill。
- `mapSkillhubInstalledItem` 当前无条件产生 `SkillHub` 来源，忽略 ACLI item/instance 的 `source`。
- `mergeInstalledWithHermes` 当前匹配到 Hermes builtin 后仍保留 registry 行的来源与默认可卸载状态；`getInstalledSources` 又优先展示 marketplace registry，形成截图中的误标与垃圾桶。

## 验证口径

- 新增 parser/merge 回归测试，覆盖 SkillHub item/instance 的 `source: builtin` 以及 Hermes builtin 覆盖匹配 SkillHub 记录。
- 新增组件回归测试，确认合并后的预置项显示“系统预置”且没有删除按钮。
- 运行 Skills 定向 Vitest、`pnpm i18n:check`、`pnpm check`、`git diff --check` 和 context change-impact staged 检查。
