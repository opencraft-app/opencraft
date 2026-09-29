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
验证结果及未决项记录于本次 FE-AI change 的 report；提交前运行相关 Vitest、node:test、pnpm check、build:cn、build:global、diff 检查和 context 门禁。

## risks / handoff
本 MR 不代表上线。需要远端 CI 与人工 CR 后再决定合并；回滚通过反向提交本 MR 完成。原始素材和旧实验素材保留在本地，不随提交上传。
