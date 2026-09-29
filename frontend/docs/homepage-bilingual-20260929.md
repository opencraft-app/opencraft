# 双站首页布局与多语言适配

## goal
交付用户验收的紧凑首页：双站顶部使用浅紫形象，其余区域保留黑色形象，同步多语言与移动端。

## non_goals
- 不改变鉴权、订阅、计费、后端接口、GitOps 或生产环境；不自动合并、发布。
- 不纳入主工作区的其他改动。

## requirement_refs
本次用户对话及截图；最终确认「国内国际都要这个浅紫色的，提 MR」。相关历史需求为工蜂 [#74](https://git.woa.com/wisp/mono2/issues/74)，本次按后续用户确认的七卡与新标题方案演进，不宣称原八卡验收全部完成，不自动关闭 Issue。

## interface_refs / data_structure_refs
- `next-site/international-home-runtime.tsx`：共享脚本/样式生命周期，保留 CTA、会话和反馈入口。
- `scripts/import-international-homepage.mjs`：生成入口，新增素材保留清单与统一后处理。
- `scripts/international-home-feature-locales.mjs`：八语言文案与装饰结构，生成物不可作为独立真源。

## history_context
- current_design_refs：`frontend/AGENTS.md`、已验收首页预览。
- relevant_evolution：以 `621550778` 隔离基线迁入预览改动，保留 master 已有博客与反馈入口。
- superseded_refs：黑色顶部素材仅为历史方案；最终顶部是浅紫色。

## acceptance
- 双站使用同一顶部浅紫素材，轮播短词不推动角色位置；日语韩语句尾不与角色重叠。
- 七张紧凑特性卡，按用户要求精简文案、调整确认气泡、修正插图裁切与页脚底色。
- 保留语义链接、语言与站点入口；离屏、隐藏标签页、减少动态偏好下暂停装饰动画。
- 相关测试、生成器测试、类型检查、双站构建通过后提交；不将本地构建视为生产发布。

## affected_paths
`next-site/international-home-runtime.tsx`、`public/lightvela-intl-home/`、相关 scripts/tests、字体子集及工蜂 Skill。

## context_receipt
| 文件 | 用途 |
|---|---|
| `docs/context/project/services/frontend.md` | 双站 UI 边界与验证范围 |
| `frontend/AGENTS.md` | 图片默认 WebP、check/test/build 门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 核对生成器及测试邻居 |
| `frontend/vitest.config.ts` | 测试运行环境与 alias |
| `.agents/context/change-impact.json` | 本次不命中运行时架构文档强制映射 |
| `.agents/skills/gongfeng/SKILL.md` | 复用现有连接，不提取或输出凭据 |

## decisions / review
- 图片转换为无损 WebP，保留透明像素，不重绘用户提供的形象。
- 测试按实际批准后的七卡结构更新；资源扩展名更新为 WebP，语言标题使用固定期望，不能从被测 DOM 反推期望。
- 动效控制器的观察器、resize/visibility/media 监听通过既有 dispose 事件清理；只读取静态词组，不新增网络写入。
- P2：兼容层 CSS 仍有多轮覆盖规则，后续可另案收敛；本次不扩大视觉重构范围。

## validation / evidence
- 全新 `pnpm install --frozen-lockfile` 通过，未复用 node_modules 软链。
- 首页/渲染/可访问性/头像四个相关 Vitest 文件 69/69；语言生成器 node:test 13/13。
- `pnpm check`：TypeScript 166 current / 171 baseline / 0 new / 5 resolved；i18n 错误 0、既有告警 46。
- `pnpm build:cn` 与 `pnpm build:global` 均通过，SEO 路由检查分别 8、42 条；素材转换后重复构建通过。
- 新增浅紫 WebP 与原 PNG 的非透明像素及 alpha 完全一致；透明像素的不可见 RGB 被编码器清理。新增文件的字面量素材引用全部纳入 Git，无新增缺失路径。
- `git diff --check`、三份 JS 语法检查、工蜂 Skill 校验、documentation validator、staged change-impact 通过。
- Context 测试 22/26，4 项失败为原有 tasks 文档的 frontmatter/中文优先规则；报错文件未被本 MR 修改。context-audit 单测 33/33，审计发现已运行，不虚构成熟度分数。
- 合入 `cfb478aef` 后确认前端与 Skill 文件未变化；本 MR 对 master 的差异不含合并带来的后端/GitOps 文件。

## risks / handoff
本 MR 不代表上线。需要远端 CI 与人工 CR 后再决定合并；回滚通过反向提交本 MR 完成。原始素材和旧实验素材保留在本地，不随提交上传。

## MR !4800 评审修复
- 检查工蜂评审面板两页共 6 条意见：4 条工作台标题语义、1 条轨道坐标常量、1 条生成 HTML 可读性。
- 将已批准的一句话工作台文案提升为原生 `h4`，保留原字号、颜色和间距，不恢复用户明确删除的旧标题；同步默认页和 8 个语言片段。
- 技能轨道图标与坐标合并到具名数据常量，提取动画错峰常量，避免平行数组错位。
- 生成的装饰块按标签分行缩进；测试覆盖重生成幂等性、七卡标题和多语言固定文案。缓存版本更新为 v98。
- 验证：生成器 13/13；首页相关 Vitest 独立重跑 69/69（并行构建时曾有一项超时，未提高测试时限）；`pnpm check` 0 新增类型错误、0 i18n 错误；国内/国际构建与 SEO 路由检查 8/42 均通过。
- 对比原提交的 9 份 DOM，卡片文字、图片路径及轨道坐标一致；文档检查、JS 语法、staged change-impact 与 diff 检查通过。
- 交接检查点：追加到原 MR !4800，等待远端检查与人工复审。不合并、不发布。

## 第二轮评审核验
- 确认并修复页脚 CTA：装饰生成器不再改写按钮文案，9 份片段恢复 master 中与 `/agents` 匹配的原始译文；新增真实中文片段在未登录、未订阅、已订阅状态下的运行时测试。
- 确认并修复 hero 双重注入：导入器直接使用 `lv-cover-lavender.webp`、528×410；本地化生成器不再覆盖形象，移除旧图的保留名单项。
- 资源疑问不成立：`git ls-tree origin/master` 确认 automation/workbench/deepseek/workspace-carousel 所列 WebP 已被跟踪，来自 `27c0afb5b`（!4554），不是依赖本地未提交文件。
- 字体疑问不成立：`style.css` 的 Allura `@font-face` 引用 `assets/fonts/allura-latin.woff2`，同文件定义 `--font-footer-display`；字体文件已被 Git 跟踪。补充变量/字体资产回归断言。
- 检查点：生成器 16/16、首页相关 Vitest 72/72；`pnpm check` 0 新增类型错误；双站构建及 SEO 路由检查 8/42 通过；文档、JS 语法、staged change-impact、diff 检查通过。本轮只修复评审问题，不变更视觉方案，不合并发布。
