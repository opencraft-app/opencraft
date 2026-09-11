## goal
修复国内站已安装 Skills 列表将 Hermes bundled Skills 误标为 SkillHub 并允许删除的问题。

## non_goals
- 不修改搜索、安装或批量安装流程。
- 不修改普通 SkillHub 技能的来源与卸载行为。
- 不修改国际站 ClawHub / skills.sh 规则、发布配置或生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图与 2026-09-11 对话：默认内置技能应显示“系统预置”，用户明确要求处理该 Bug。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/skills-demo/skill-registries.ts`：`SkillhubListItem`、`InstalledSkill`、`parseSkillhubList`、`mergeInstalledWithHermes`。
- `frontend/src/lib/hermes-skills-client.ts`：`parseInstalledSkills` 与 `.bundled_manifest` 来源校准。
- 不变量：Hermes/bundled 明确判定为 `builtin` 的技能不可卸载；普通 registry 安装记录仍按 registry 身份执行卸载。

## history_context
- `current_design_refs`：`.agents/skills/product-skills/lv-sitepage-skills/SKILL.md` 的 My Skills 来源规则。
- `relevant_evolution`：`77daa6f73` 引入系统预置来源与不可删除语义；`66d24a92e` 展开 SkillHub installed instances，但未保留 instance `source`。
- `superseded_refs`：无。

## acceptance
- SkillHub installed item 或 instance 明确返回 `source: builtin` 时，列表显示“系统预置”且不可删除。
- Hermes 权威列表把匹配的 SkillHub 记录判定为 builtin 时，最终仍显示“系统预置”且不可删除。
- 普通 SkillHub installed 记录继续显示 SkillHub 并可卸载。
- Skills 定向测试、i18n、前端检查和 diff 检查通过。

## affected_paths
- `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
- `frontend/typecheck-baseline.json`（仅移动因本次新增行而变化的 6 个既有诊断位置，不新增诊断）
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `frontend-product-surface`
- `service-frontend`
- `site-environment-routing`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@88ad7fced` | 仓库 P0 与 Task Pack 规则 | 保持授权和验证边界 |
| `frontend/AGENTS.md@88ad7fced` | 前端服务规则 | 选择定向测试与前端门禁 |
| `docs/context/project/services/frontend.md@revision-2.1.0` | 路由 must_read | 确认前端来源与测试权威 |
| `docs/context/domains/site-environment-routing.md@revision-2.0.0` | 路由 must_read | 将变更限定在国内站，不推断发布状态 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@revision-1.0.0` | 前端测试邻接 | 检查实现与相邻测试，不扩大 locale 范围 |
| `.agents/skills/product-skills/lv-sitepage-skills/SKILL.md@88ad7fced` | Skills 页面产品规则 | 确认 builtin 显示与不可删除语义 |

## evidence
- `python3 .agents/context/scripts/validate_context.py --route "frontend/src/pages/marketing/skills-demo/skill-registries.ts builtin SkillHub installed source merge"` 命中三个 Pack。
- 当前目标源码与测试文件在开工前无未提交改动。
- `images/build.sh` bundled keep list 与截图技能名称相符。
- `validate_change_impact.py` 确认前端变更命中 `site-environment-routing`，已同步正式设计文档中的 Skills 已安装来源边界。
- 先新增 parser、merge 与组件断言，旧实现分别暴露来源未保留、Hermes builtin 未覆盖及 UI 仍可删除；实现后定向用例全部通过。

## risks
- registry 与 Hermes 同时返回同一 Skill 时可能错误覆盖真实 marketplace 来源；仅对明确 `builtin` 采用覆盖，并用普通 SkillHub 回归测试防护。
- instance 的命令目标不能被展示来源修复改变；保留 `rawId` 与卸载目标结构。

## validation
- `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx --reporter=dot`：通过，2 个文件、104 个测试。
- `cd frontend && pnpm i18n:check`：通过；本次未新增翻译文案。
- `cd frontend && pnpm check`：通过；TypeScript 190 current / 276 baseline / 0 new / 86 resolved，i18n 与文档生成检查通过，保留 48 个既有翻译告警。
- `git diff --check -- <本次文件>`：通过。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，0 errors、0 warnings、0 broken first-party links。
- 在临时 detached worktree 中仅应用并暂存本次补丁后运行 `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过，命中 `site-environment-routing`，无需额外 owner review。

## decisions
- Hermes bundled/source `builtin` 对预置属性具有权威性；owner：本次用户确认。
- 不按技能名称维护硬编码白名单，避免镜像版本变化造成漂移。

## scan_scope
- `frontend/src/pages/marketing/skills-demo/`
- `frontend/src/lib/hermes-skills-client.ts`
- `images/build.sh`

## scan_output
- 使用既有 graphify 查询定位 `parseSkillhubList`、`mergeInstalledWithHermes`、`getInstalledSources`，随后以源码和测试核验。

## handoff
- brief 已获用户确认；实现与验证完成，未提交、未推送、未发布，也未在生产环境执行交互回归。
