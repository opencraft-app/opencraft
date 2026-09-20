# 人设原版视觉恢复

## goal
按用户 2026-09-20 指示恢复人设页原版样式，保留现有加载逻辑。

## non_goals
- 不处理上一轮发现的全站加载问题，不改接口、权限、持久化、计费或导航。
- 不覆盖或提交 DevCloud 规划，不创建 MR，不改生产环境。

## requirement_refs / requirement_excerpt
- 当前对话：“人设这个页面，除了加载逻辑以外，重新回到原有的样式实现吧”。

## interface_refs / data_structure_refs
- `BuddyPanel` 保留 Bot/profile、请求防竞态、注入/删除/复制/下载处理。
- `agent-buddy-views.tsx` 保留独立原生卡片按钮、Radix 焦点锁定与回焦。

## history_context
- current_design_refs: `frontend/src/pages/marketing/agent-buddy-README.md`
- relevant_evolution: `222a2cc51` 引入 Agents 统一样式，`b921c559e` 合入 master。
- 视觉参照为已合入的 `f2a1ec32f`，仅恢复表现属性；禁止整文件覆盖历史功能。

## acceptance / validation
- 恢复渐变标题、原版圆角/阴影、胶囊按钮、卡片状态与人设弹窗。
- 首屏仍展示“正在读取人设”；loading 条件及其局部实现不改。
- 人设专项测试、pnpm check/build、git diff --check。

## affected_paths
- `frontend/src/pages/marketing/agent-buddy*`
- `frontend/src/pages/marketing/agent-*persona*`
- 对应测试、OpenSpec、模块 README。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库边界 | 保留现有工作及提交确认 |
| `frontend/AGENTS.md` | 前端规则 | 复用组件、运行门禁 |
| `docs/context/project/services/frontend.md` | must_read | 服务范围 |
| `docs/context/domains/site-environment-routing.md` | must_read | 不改站点行为 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻接检查 | 定位人设测试 |
| `frontend/DESIGN.md` | 展示规则 | 用户明确要求原版视觉，本轮局部恢复不影响通用规范 |

## decisions
- 本次是既有视觉恢复，不创作新方案；可访问性修复保留。
- 用户已确认提交本轮人设改动并推送 frontsandbox/agents-radix-refactor；OpenCraft sourceRevision 元数据提交单独确认。

## evidence
- 初始工作树仅存在 DevCloud 规划的三份文档改动。
- 恢复人设卡片面板、渐变标题/徽标、胶囊按钮、圆形操作及预览、删除确认、抽取、测试、上传和文件编辑弹窗的原版视觉。保留 Radix 焦点/Portal 和独立原生按钮语义。
- 最后一轮专项验证：8 个文件 126 项测试通过（43.55s，exit0），包含加载等待、注入/删除/复制/下载、焦点恢复及新增视觉结构断言。jsdom 下载测试有两条既有 navigation 未实现提示，不影响测试通过。
- pnpm check：exit0，168 current / 276 baseline / 0 new TS diagnostics；49 条既有 i18n warnings，0 errors。仓库无独立 lint script，采用项目 check 门禁。
- pnpm build：exit0，完成 103 个静态页及 8 条 SEO route 检查；包含末次弹窗内部滚动布局修改。
- npm run check:mono2-agent-console：exit0，161 文件无漂移；人设不在该共享生成闭包，无需更新生成组件，但源码提交后标准脚本会更新 sourceRevision。
- git diff --check 通过；已恢复本次构建改写的 next-env.d.ts，不保留无关生成文件变更。
- 未进行本轮真实浏览器视觉验收；组件测试不能证明像素级一致。localhost:5174 属于另一工作树，未作为本次预览证据。

## handoff
- 当前阶段：本地实现与验证完成，用户已确认分支预览交付；提交及推送回执另行记录，不把推送成功等同于 CI 发布完成。
- 加载判断、请求生命周期、多 Bot、注入/删除/复制/下载业务处理保持不变，全站加载诊断后的修复未纳入本轮。
- 既有 DevCloud 规划保留；本轮在 frontsandbox/agents-radix-refactor 工作树增量修改，没有整文件回退。
