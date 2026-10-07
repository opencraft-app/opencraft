---
id: remove-cn-featured-anniversary-2026-10-07
type: task
scope: 国内站技能精选调整与 SkillHub 技能接入。
triggers: ["domestic skills featured", "SkillHub curation", "featured skill order"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-07-remove-cn-featured-anniversary.md
status: active
reviewed_at: 2026-10-07
review_due: 2026-11-07
revision: 1.0.0
precedence: task
derived: false
---

## goal
将国内站技能页精选列表中的周年活动卡替换为「编程专家.Skill」，追加「育儿大师.Skill」，并把「腾讯文档 TENCENT DOCS」放在第 5 位。

## non_goals
- 不改国际站精选、国内站分类的展示内容与顺序、SkillHub 搜索或已安装技能数据源。
- 不合并、发布或修改线上服务。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-07 截图圈选国内站 `lightvela.com/agents/skills/` 第一张精选卡片，要求去掉。
- 用户随后提供 `https://skillhub.cn/skills/indiv-ebandao/dev-expert`，要求换成该技能。
- 用户再指定精选首屏顺序为 find skill、提示词生成大师、编程专家。
- 用户提供 `https://skillhub.cn/skills/indiv-ebandao/parenting-expert`，要求把育儿大师加入精选。
- 用户提供 `https://skillhub.cn/skills/tencent-adm/tencent-docs`，要求把腾讯文档加入精选第 5 位。

## interface_refs / data_structure_refs
- `DOMESTIC_FEATURED_SKILLS` 是国内站精选卡片配置；`FEATURED_BATCH_SIZE` 控制每页三张。

## history_context
- `current_design_refs`: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx` 与 `domestic-skill-catalog.ts`。
- `relevant_evolution`: 原列表有九张，上一轮仅移除首位活动卡，用户随后要求以新技能补上。
- `superseded_refs`: 无。

## acceptance
- 国内站精选首屏依次为 `find-skill-skillhub`、`image-prompt-skill`、`@indiv-ebandao/dev-expert`，不再渲染周年活动卡；其余六张保持顺序。
- 腾讯文档位于精选第 5 位，使用完整身份 `@tencent-adm/tencent-docs`；常用工具分类中的同一技能统一到该身份。
- 育儿大师追加到精选末尾；精选十一张，末页两张；分类中的同一技能统一到完整身份 `@indiv-ebandao/parenting-expert`。
- 三张新增技能有各自独立横幅、正确 SkillHub 来源与安装身份、完整中文详情和已翻译的卡片文案。
- 国际站与国内站分类保持现状；前端相关门禁通过。

## affected_paths
- `frontend/src/pages/marketing/skills-demo/`、`frontend/src/i18n/generated/` 和精选资源。

## required_context
- 首轮路由器无匹配 Pack；新增需求路由到 `site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 服务边界与门禁 | 决定验证范围 |
| `frontend/openspec/plan.md` | Skill 工作流要求 | 核查现有前端计划 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端变更邻接 | 定位相邻测试 |
| `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx` | 运行时渲染 | 确定分页与文案引用 |
| `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.ts` | 精选真源 | 移除指定卡片 |
| `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.test.ts` | 相邻测试 | 更新精选列表断言 |
| `docs/context/domains/site-environment-routing.md` | 双站边界 | 限定国内站修改 |
| `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.zh.ts` | 中文详情模板 | 增加新技能独立详情 |

## evidence
- 首轮路由器无 Pack 匹配，新增需求命中站点路由 Pack；精确搜索定位到国内精选数据源、详情模板和相邻测试。
- SkillHub 页面及公开搜索接口确认 `@indiv-ebandao/dev-expert` 的完整身份、名称、图标、用途与来源 URL。
- SkillHub 页面及公开搜索接口确认 `@indiv-ebandao/parenting-expert` 的完整身份、名称、图标、用途与来源 URL；分类中的旧短 ID 指向同一技能。
- 独立生成横幅并转为 1200×600 WebP，55,616 字节；`pnpm build` 重新生成字体子集。
- 育儿大师另生成 1200×600 WebP 横幅，55,782 字节。
- `pnpm i18n:check` 通过，六个必填语言新增文案均已翻译。
- 定向 Vitest 2 个文件，70/70 通过；本机 `localhost` 无法解析，使用未纳入改动的临时配置设置 `127.0.0.1`。
- `pnpm check` 通过：166 current / 171 baseline / 0 new TypeScript diagnostics。
- `pnpm build` 通过，国内站静态页面生成完成。
- `git diff --check` 通过。
- 育儿大师追加后 `pnpm i18n:check`、定向 Vitest 72/72、`pnpm check`（166 current / 171 baseline / 0 new）与 `pnpm build` 通过；组件测试覆盖末页单卡和精选/分类短 ID 已安装状态一致。
- 腾讯文档的 SkillHub 页面确认完整身份 `@tencent-adm/tencent-docs`；第 5 张精选与常用工具分类共用该身份和用户提供的来源 URL。
- 腾讯文档生成独立 1200×600 WebP 横幅；定向 Vitest 73/73、`pnpm i18n:check`、`pnpm check`（166 current / 171 baseline / 0 new）、`pnpm build` 与 `git diff --check` 通过，构建产物包含新横幅路径。

## risks
- 精选十一张，末页两张；需验证分页和两个入口的已安装状态一致。

## validation
- `pnpm i18n:check`、`pnpm check`、定向 Vitest、`pnpm build`、`git diff --check`。

## decisions
- 首屏第三位使用用户指定的完整 SkillHub ID；旧技能详情模板保留供动态搜索结果使用。
- 新图使用独立 AI 生成的 `.webp`，其余精选卡位置不变。
- 育儿大师使用完整 SkillHub ID 追加到精选末尾；分类的同名条目更新到该 ID，避免两个入口安装目标分叉。
- 腾讯文档使用完整 SkillHub ID 插入精选第 5 位，分类同名条目更新到该 ID；独立生成横幅。

## scan_scope
- `frontend/src/pages/marketing/skills-demo/` 与对应静态资源引用。

## scan_output
- 精确查询命中卡片配置、定制文案、特殊遮罩、详情模板和测试。

## handoff
- 技能页源码已提交至 MR !5059；CI 发现 OpenCraft 生成副本漂移，正在作为后续独立提交同步。未合并、未发布。
