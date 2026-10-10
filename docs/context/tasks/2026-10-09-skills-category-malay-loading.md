# 技能分类误加载马来语修复

## goal
修复中文和其他非马来语技能页因未加载马来语文案而崩溃的问题。

## non_goals
- 不修改翻译生成物、文案加载器、首页改动或生产部署。

## requirement_refs / requirement_excerpt
- 当前用户请求：“修复”；截图错误为 `Malay public copy must be loaded before rendering`。

## interface_refs / data_structure_refs
- `SkillsDemoPanel.tsx:getCategoryLabel`：非马来语分类标题不得依赖马来语资源。
- `src/i18n/index.ts:LAZY_DICTIONARY_LOADERS`：马来语资源按需加载。

## history_context
- current_design_refs: `frontend/openspec/specs/marketing.md`。
- relevant_evolution: `6802d5abe0` 在马来语翻译函数中要求文案预加载；分类标题对象仍无条件求值马来语翻译。

## acceptance
- 国内中文、英文和国际站全部非马来语分类在马来语资源未加载时可渲染。
- 马来语预加载后仍显示翻译后的分类。
- 执行前端 check、test、build，记录已有问题和环境限制。

## affected_paths
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

## required_context / context_receipt
- 路由查询 `frontend skills page Malay category label runtime crash` 无匹配 pack；有界精确搜索定位 `getCategoryLabel` 与 `localizeMalay`。
- 已读取 `AGENTS.md`、`frontend/AGENTS.md`、Task/Checkpoint 模板、`frontend-runtime-openspec-i18n.md` 邻接卡、`marketing.md` 路由规格、`src/i18n/index.ts` 与马来语加载测试、`frontend/vitest.config.ts`。
- change-impact 配置未覆盖本次营销页面实现变更。

## evidence
- 修复前组件测试 71 项全部失败，同一错误和调用链与用户截图一致。

## risks / decisions
- 保留资源加载器的严格校验；仅将分类翻译改为当前语言为马来语时求值。
- 当前 worktree 含其他首页改动，保留已有文件；构建结果须区分共享工作区状态。

## validation
- 修复后四个相关测试文件全部通过：92 项，包含 8 个非马来语分类渲染用例和马来语预加载后的渲染用例。日志：`/tmp/lightvela-skills-malay-focused-tests.log`。
- `pnpm check` 的 i18n 提取、翻译结构、繁简及文档检查通过；类型门禁被共享工作区依赖/类型错误阻断。最终 `pnpm typecheck` 未报告本次两个源码文件错误；日志：`/tmp/lightvela-skills-malay-typecheck.log`。
- `pnpm build` 在 Turbopack 推断 workspace root 时失败。改用 `next build --webpack` 仍被缺失的 `@opencraft/workbench-panels/host-presentation`、相邻 velalink 包的 `lucide-react` / `@tanstack/react-virtual` 等依赖阻断；未修改构建配置或依赖。日志：`/tmp/lightvela-skills-malay-build.log`、`/tmp/lightvela-skills-malay-webpack-build.log`。
- 全量 Vitest 已尝试，日志出现其他模块失败且会话已失效，未取得完整统计；不宣称全量通过。日志：`/tmp/lightvela-skills-malay-tests.log`。最终相关测试单独重跑全部通过。
- `git diff --check`、文档校验（errors 为空）通过。`validate_change_impact.py --staged` 通过，但当前未暂存任何文件；已人工核对本次路径不命中设计映射。

## handoff
- 本地源码与生成副本已分别提交，工作树干净；92 项相关测试及 133 项同步检查通过。推送失败，尚未创建 MR、合入或发布。

## stage
本地提交完成；远端网络阻断。发布前仍需在依赖齐全的环境完成全量门禁。

## verified
- 错误来自分类标题对象的马来语字段无条件求值；按语言分支修复后 92 项相关测试通过。

## unverified
- 生产构建产物和线上页面：尚未构建成功或发布。

## discard
- 最初新增用例误用 heading 角色查询；已按实际分类标题使用文本查询并重新通过。

## restore
- 保留同一 worktree 其他首页改动；本次实现仅修改 SkillsDemoPanel 和相邻测试。

## next_action
- 在具备工蜂及发布网络的环境刷新 master，复核分支、推送、创建并合入 MR，完成国内正式站构建/发布与线上验收。已有用户授权，无需再次索要相同操作授权。

## delivery_authorization
- 用户明确要求“提交合入发布”，授权本次修复的 commit、push、MR 合入和 lightvela.com 发布。
- 建立独立 worktree `/data/mono2-skills-malay-hotfix-20261009`，分支 `fix/skills-category-malay-loading-20261009`，基于缓存 `origin/master=f1ce589f18`；仅迁移本次两个源码文件和此任务记录。
- 实际网络探测：git fetch 因 git.woa.com DNS 解析失败而无法刷新；既有 SSH 执行桥连接发布机被 `socket: Operation not permitted` 拒绝。没有成功执行远端写入，不假定已合入或发布。
- 已读取 site-environment-routing/release-gitops Domain Pack、网站运维技能的凭据/环境/生产参考、工蜂技能、`.ci/AGENTS.md`、国内 EdgeOne 发布定义和触发入口。
- 本次生产写入授权来自用户指令，高于网站运维技能历史任务中的生产只读约束。未启用任何额外区域发布。
- 国内当前仓库发布定义为 `.ci/frontend-edgeone-lightvela.yml`，combo `eo:cn-lightvela-prod-next`，项目 `lightvela`；依赖在线核验实际制品来源和流水线状态。
- `check:mono2-agent-console` 发现本次 SkillsDemoPanel 生成副本漂移；按 frontend/AGENTS.md，先提交真源，再用生成器同步并独立提交。
- 真源提交：`d3a38791e2ab37ddc82b968b7dd8d34dca0c8008`。同步生成器只修改生成 SkillsDemoPanel 与 UPSTREAM 清单；133 项副本校验通过，清单 sourceRevision 指向上述提交。
- 独立分支修复验证重新通过（四个测试文件、92 项）；本地补齐 package.json 已声明的 file: 依赖链接，仅写入忽略的 node_modules，未修改依赖声明或共享依赖目录。日志：`/tmp/lightvela-skills-malay-isolated-tests.log`。
- 国内发布入口 dry-run 已核对，只输出目标与 SHA，没有发起流水线。
- 独立分支 `pnpm check`：i18n/文档检查通过，类型门禁仍被依赖及相邻包问题阻断（186 current，43 new）；日志 `/tmp/lightvela-skills-malay-isolated-check.log`，本次 SkillsDemoPanel 文件没有诊断。
- 实际 `git push origin HEAD:refs/heads/fix/skills-category-malay-loading-20261009` 因 git.woa.com DNS 解析失败而退出 128；没有远端提交回执。
- 网络仍受限，尚未推送、创建 MR、合入或发布。已准备 MR 描述 `/tmp/lightvela-skills-malay-mr-description.md`；后续在具备工蜂/发布机网络的执行环境继续，沿用本轮授权。
