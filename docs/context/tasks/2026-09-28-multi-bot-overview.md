---
id: multi-bot-overview-2026-09-28
type: task
scope: 双站多 Bot 总览与管理改版的实施任务。
triggers: ["多 Bot 总览", "multi-bot overview", "jasminzhao-zonglan-928"]
owner: jasminzhao
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-09-28-multi-bot-overview.md
status: active
reviewed_at: 2026-09-28
review_due: 2026-10-28
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：多 Bot 总览

## goal
落实用户提出的多 Bot 总览需求，突出创建入口并支持按目标 Bot 管理。

## non_goals
- 不发布，不改变后端/生产资源，不接管旧工作区任务。用户最新明确授权本需求合并 master、commit/push 及创建 MR；不执行 MR 合并。

## requirement_ids / requirement_refs / requirement_excerpt
- `wiki/prd-docs/2026-09-28-multi-bot-overview.md`：全局总览、卡片管理、显式创建入口。
- 用户 2026-09-28 明确要求创建 `jasminzhao-zonglan-928`、整理 PRD 并启动开发。

## interface_refs / data_structure_refs
- `frontend/src/contexts/agent-context.tsx`：OpenClawBot、创建配额、列表。
- `frontend/src/repositories/types.ts`：renameBot/deleteBot/retryBot。
- `frontend/src/lib/agent-routes.ts`：目标 Bot query 与工作区路由。
- `frontend/src/pages/marketing/agent-buddy-profile.ts`：按 Bot/profile 读取资料。
- 不可将空 connectedChannels 当作离线，不可猜子 Bot profile 为 main。

## history_context
- current_design_refs：`frontend/DESIGN.md`、上述 PRD。
- relevant_evolution：相邻 `agent-multi-bot-onboarding.test.ts` 守护创建流程不重挂载、明确来源 Bot；profile-isolation 测试守护配置隔离。
- superseded_refs：初版单 Bot 资料卡仅用于兼容回落。

## acceptance
- 多 Bot 同屏、创建可见；操作按 ID 隔离；门禁和引导保持；未知统计显示占位。

## affected_paths
- frontend/src/pages/marketing/、frontend/src/i18n/generated/、wiki/prd-docs/、本 Task Pack。

## required_context
- frontend-product-surface、service-frontend、site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md` | 本轮交付路由 must_read | 工蜂交付范围与授权 |
| `docs/context/flows/change-delivery.md` | 交付邻居 | 评审与检查点交接 |
| `.agents/skills/gongfeng/SKILL.md` | 用户要求提 MR | 经 mcporter-internal 创建工蜂 MR |
| `AGENTS.md` | 仓库边界 | Git 授权与验证 |
| `docs/context/project/services/frontend.md` | 路由 must_read | 前端职责 |
| `docs/context/domains/site-environment-routing.md` | 路由 must_read | 双站/开关独立 |
| `frontend/AGENTS.md` | 服务边界 | 组件复用与门禁 |
| `frontend/DESIGN.md` | 样式规则 | 卡片、弹窗 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻接卡 | 定位相邻测试 |
| `frontend/src/contexts/runtime-config-context.tsx` | 邀请功能邻居 | 复用账号页 referralEnabled 开关 |
| `frontend/src/pages/marketing/referral-section.tsx` | 账号页邀请来源 | 复用 successfulReferrals 统计口径 |
| `.agents/context/change-impact.json` | 设计同步路由 | 当前营销页面及翻译不命中强制设计映射 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 任务状态 | 本文件结构 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | 续接状态 | 交接检查点 |
| `.agents/skills/product-skills/prd-creator/SKILL.md` | 用户要求补充 PRD | 基于已确认交互更新本地文档 |
| `.agents/skills/product-skills/prd-creator/references/prd-template.md` | PRD 补充 | 范围、状态、验收与交接结构 |
| `.agents/skills/product-skills/prd-creator/references/checklist.md` | PRD 交接 | 仅本地文档，不触发外部写入 |

## evidence
- `git pull --ff-only origin master` 成功，基点 `15236bf99`。
- 分支 `jasminzhao-zonglan-928` 位于独立 worktree。
- 原工作区三项变更保存在命名 stash `preserve-context-before-jasminzhao-zonglan-928`，未混入新需求。
- 原 frontend 存在 unrelated `international-bot-onboarding` active change；新工作树单独启动 `multi-bot-overview-928`。

## risks
- profile/cron 数据跨目标串用：每次请求保持 Bot/profile 作用域。
- 现有页面状态门禁复杂：聚焦测试新手引导、升级和空态。

## validation
- frontend `pnpm check`、`pnpm test`、`pnpm build`；新组件行为测试和视觉验证。
- 根 context/documentation 验证、两个 unittest suite、context audit、change-impact staged 检查。

## decisions
- 用户已通过“整理 PRD 并启动修改”授权实施已展示方案，不重复申请方案批准。
- 用户已明确要求双站同步，国内站与国际站共用新总览；各站权限规则保持。

## scan_scope
- 前端总览/settings/profile/路由/Repository 邻居，禁止全仓扫描。

## scan_output
- 记录源码范围、相邻测试和数据可用性在本文件及 PRD。

## validation_results
- `pnpm check`：通过，166 条当前类型诊断/171 条基线，0 条新增；翻译结构无错误。
- `NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm build`：通过，退出码 0。
- 聚焦 Vitest：11 文件、96 条通过。日志 `/tmp/zonglan-928-final-focused.log`。
- 实际组件浏览器 fixture：桌面与 390px 手机无横向溢出；重命名交互通过，无页面异常。仅模拟数据，未操作线上账号。
- `pnpm test`：未通过且有 worker 未结束，已停止本轮进程。对照干净 `15236bf99` 复现侧栏、模型配置、第三方包 ESM 等既有失败；总览新增后旧 mock 的缺失导出已修复并回归通过。
- 文档校验通过，context-audit 测试 33/33；context 单测 26 条中 4 项失败，干净 master 同名失败。
- `validate_context.py --build-catalog` 因仓库既有 context 元数据等错误未通过；本次 Task Pack 与检查点元数据已补齐，最终校验未报告这两份文件的问题。
- 实际改动集已暂存执行 `validate_change_impact.py --repo . --staged`：通过，未命中强制设计同步映射；`git diff --check` 通过。
- 完整日志位于本机 `/tmp/zonglan-928-*.log`，不包含合并/发布结论。

## handoff
- 前端实现与 PRD 已完成本地评审准备；当前 workflow 保留 verify。用户最新已明确授权合并 master、整体 CR、提交并推送指定分支及创建 MR；不执行 MR 合并或发布。
- 站点范围已明确为双站同步；真实账号写入仍待测试环境验收。

## 后续用户反馈
- 用户授权修复 SOUL 读取失败覆盖正文风险并切换国内站。共享保存流程现校验命令结果与读取协议，仅 ready/missing 可继续；其他状态停止写入并在原弹窗保留草稿、显示已有多语言错误，读取中禁用保存。读取命令区分不存在与已有空文件。187 条相关测试、check 及国内隔离构建通过。原国际开发进程已停止，国内 dev:cn 在 5174 启动并返回 HTTP 200。
- 整体 CR：从改版前 `15236bf99` 审阅到当前工作区，未发现新增阻塞问题；222 条相关测试、check 通过。确认原 SOUL 读取失败后仍按新建写入的遗留风险，保存实现与基点逐字一致；未混入行为修复。PRD 已整合最终交互、六语言、空值口径、验收和风险，移除过期任务聚合/修复入口描述。
- 已邀请好友无数据统一显示 0，包含加载中、请求失败及响应缺少统计值；核对现有六个翻译语种（en-US、zh-Hant、id-ID、es、ja-JP、ko-KR）的总览新增文案，已全部有译文，保留现有翻译，不重复改写。六语言渲染测试与总览文案完整性检查覆盖新增多 Bot 组件。
- 顶部新增已邀请好友，复用账号页现有邀请统计及功能开关，点击跳转账号管理；Bot 数量点击跳转总览页。首次以“frontend 总览 HeroBanner 已邀请好友数量 账号管理”路由未命中，精确搜索 marketing/lib/domain 未命中邀请人数名称，扩展至 src 定位 referral-section 与 Repository；随后使用确切文件路径命中 frontend 路由。
- 顶部移除定时任务与工作台指标，沿用原横幅展示剩余积分和 Bot 数量；Bot 数量取同一份列表，加载中或失败时显示占位符。
- 桌面按数量展示：1 个 Bot 满宽、2 个各半宽、3 个及以上一行三个；删除空白创建卡片；卡片仅保留头像、名字、简介、名字右侧状态和三点菜单。
- 菜单顺序为修改资料、复制 Bot、删除；资料编辑覆盖名称和简介，所有操作保持目标隔离。
- 最终聚焦测试 35 条通过；check 无新增类型诊断。实际组件使用模拟数据完成卡片和弹窗视觉检查，线上资料未写入。
- 后续样式修复：卡片移除阴影并采用 4px 圆角；定时任务动态图片改为现有 WebP 路径。41 条聚焦测试通过，check 无新增类型诊断，8 张本地化配图 HTTP 与文件头校验通过，实际组件预览显示正常。

- 资料弹窗反馈：复用原有 ProfileEditDialog，移除新写的简化表单，保留头像选择及原布局。新增保存参数仅用于等待与错误反馈；目标 Bot/profile 隔离不变。48 条聚焦测试通过，check 无新增类型诊断；模拟预览截图核对原弹窗及资料预填。

- 卡片点击反馈：整卡按钮直接打开原资料编辑弹窗，菜单独立响应，沿用编辑门禁；删除侧栏 Bot 工作区标签。21 条聚焦测试通过，check 无新增诊断；模拟预览核对卡片点击与菜单打开。

- 2026-09-29：当前 Bot 角标绑定页面 activeBot.id，黑底白字置于卡片左上角。超过 3 张启用原生横向滚动，桌面保持可见 3 张；23 条聚焦测试通过，check 无新增诊断，5 Bot 模拟预览验证横向滚动到末端。

- 滚动引导修正：隐藏浏览器系统滚动条，超过 3 个 Bot 时显示提示文案及左右翻页箭头；箭头状态随滚动、数量和容器尺寸更新。23 条聚焦测试通过，check 无新增类型诊断，浏览器验证前进到末端与禁用状态。

- 分页交互反馈：删除右上角刷新按钮及左右箭头，底部居中显示可点击分页圆点，当前页为黑色短条。分页位置随容器大小、Bot 数量和手动滚动同步；23 条聚焦测试通过，check 无新增诊断。

- 顶部横幅反馈：撤销新增 globalOverview 展示与全 Bot 汇总，恢复改版前 HeroBanner（仅保留组件导出）及页面原 heroStats 输入；创建按钮采用 rounded-full，分页点缩小水平留白。53 条聚焦测试通过，check 无新增诊断，模拟预览对照截图。

- 复用原实现收口：恢复定时任务推荐；将原资料保存提取为共享 hook，命令、进度及目标隔离逻辑保持。删除委托现有页面弹窗与 handler，头像沿用原回落组件，标题与创建进度恢复跳转还原。撤销共享简介空值读取改动，删除无用 fleet-stats 模块和测试。
- 本轮聚焦组件测试 66 条、原 setup/runner 测试 74 条通过，check 无新增类型诊断；模拟组件预览核对推荐任务与原链接。


## 最新 master 合并与交付检查（2026-09-29）
- 用户明确授权：获取远程 master、合并、整体 CR，确认无新增阻塞问题后提交、推送并提 MR。
- `origin/master` 已更新到 `939c01b03119530c22128205ba64ea73e6c7ca2a`；合并提交 `7da16f8e0`，无冲突；暂存备份恢复成功。
- CR 检查全部最终变更，重点覆盖 Bot/profile 目标隔离、创建与删除门禁、原资料弹窗复用、读取失败禁止写入、邀请统计及六语言。未发现新增阻塞问题。
- 18 文件 291 条相关测试通过；check 通过，0 条新增类型错误；国内、国际隔离构建均通过。日志 `/tmp/zonglan-928-merged-{focused,check,global-build,cn-build}.log`。
- 全量测试退出 1：24 文件失败、297 通过、1 跳过；130 条失败、3954 通过、13 跳过，另有 worker 异常。干净最新 master 的失败文件对照复现主要问题，日志 `/tmp/zonglan-928-master-baseline-test.log`；不宣称全量通过。
- 文档校验通过；audit 测试 33/33；context 测试 4/26 失败及 catalog 校验失败在干净最新 master 复现，未扩大修复范围。
- 排除开发服务生成的 `frontend/next-env.d.ts`，恢复门禁产生的无关 catalog 变化；保留国内站 5174 服务。MR 描述说明验证与真实账号未写入边界。
- 追加差异对照：续费提醒的 7 条失败在本分支与干净最新 master 完全一致，均为第三方 CSS 导入异常；支付超时测试单独复跑两边均通过。日志 `/tmp/zonglan-928-{merged,master-baseline}-variable-failures.log`。


## 流水线问题跟进与再次合并 master（2026-09-29）
- 用户要求排查构建 `p-4ed28a7f9b6a4468a10dcfa92d3f9fe4` / `b-15802ae3c10f4ba9902a4dee80cf79ab`，先拉取并合并远程 master。
- 最新 `origin/master` 为 `9dd39f190`。合并侧栏及八份词典冲突：使用 master 的 AgentSidebar 布局，保留总览置顶和 Bot 删除目标隔离；按生成脚本重建合并词典。
- 本地检查发现五条词典测试引用已删除的旧 key，删除对应重复旧断言并保留现行文案断言；新侧栏读取依赖要求 listMyPasses mock 稳定，修复引导测试重复请求与内存耗尽；恢复 master 丢失的总览 locale 传参，保留原日期语言切换行为。
- 16 文件 297 条测试通过；另 2 文件 29 条修复回归通过。check 通过，六语言完整。国内、国际隔离构建通过（在恢复 locale 两行之前）；恢复 locale 后另行运行最终类型检查。
- 验证日志：`/tmp/zonglan-928-ci-{merged-test,regression-final2,final-check,final-typecheck,build-global,build-cn}.log`。
- 当前没有 `BK_CI_ACCESS_TOKEN`；按 devops-pipeline 技能，尚未调用蓝盾 API，没有该构建失败日志证据，不把本地发现直接当作流水线根因。待用户提供 token 或授权从已登录浏览器获取后继续排查。
- 本轮 context 首次 query 未匹配；更换源码路径后读取 frontend 服务、站点路由、frontend/AGENTS，检查 frontend 邻接卡及 vitest 配置。另读取 devops-pipeline/SKILL.md、reference/build-status.md、.ci/checks/frontend_guard.sh。
- 本地开发生成 next-env.d.ts 已专门 stash 备份，合并后恢复；国内预览服务保持。未操作生产或手动触发流水线。


## OpenCraft 同步漂移修复（2026-09-29）
- 用户提供的失败日志确认 `opencraft guard` 因 `i18n/generated/en-US.json` 的源/副本哈希不一致而退出；MDX deprecated option 提示不是该次退出的直接原因。本地 `check:mono2-agent-console` 复现同类错误。
- 前端源码已提交于 `03683dcd5`；按要求运行 `npm --prefix opencraft run sync:mono2-agent-console`，机械生成八份词典和 UPSTREAM.json，不手工修改生成物，不变更业务 UI。
- `npm --prefix opencraft run check:mono2-agent-console` 校验 130 个文件通过；使用实际 `.ci/checks/opencraft_guard.sh` 复验通过。
- 变更属于同步生成物，沿用此前前端 326 条相关测试、check 和双站构建记录；不将本地 guard 通过表述为远程整条流水线通过。
- 新增 context receipt：`opencraft/AGENTS.md`、`opencraft/MONO2_MIGRATION.md`、`docs/context/domains/agent-gateway-runtime.md`、`docs/context/domains/site-environment-routing.md`、`docs/context/project/upstream-subtrees.md`、`docs/context/project/services/opencraft.md`；检查 frontend 邻接卡、同步脚本、opencraft/package.json 与 CI guard。
- 用户已授权 Browser Use 获取日志/令牌；本次提供的日志足以定位，未读取或保存令牌。按既有授权将合并提交和生成物修复推送到原 MR !4760，不手动发布或合并 MR。


## 双站同步范围纠正（2026-09-29）
- 用户明确要求国内站一起改；移除 fleetOverviewEnabled 的 isGlobal 限定，继续尊重多 Bot 及原 onboarding 开关。双站共用同一总览组件，不变更国内实名/配额/后端执行权限。
- 真实浏览器国内代理页面 `https://lightvela.com/agents/` 已热更新并在刷新后复验：总览置顶，顶部 Bot 数量/邀请数，单卡满宽与当前角标，原资料弹窗及修改资料/复制 Bot/删除菜单；创建入口展示国内模板。验证仅打开/关闭 UI，未保存资料、创建或删除 Bot。
- 5 文件 87 条相关回归通过；新增国内列表/导航、创建入口、配额和开关关闭回退覆盖。国内模板另由真实浏览器确认，避免国际 fixture 的模块级模板缓存造成误判。
- check 通过：166 当前/171 基线，0 新增；六语言校验通过。国内隔离构建通过，包含静态导出及 SEO 检查。
- 日志 `/tmp/zonglan-928-cn-fleet-{test-final,check-final,build}.log`。PRD 改为国内/国际双站，沿用已有 context receipt、frontend 邻接卡及 runtime-config 邻居。
- 按既有授权提交推送同一分支，另行机械同步 OpenCraft 清单并复验 CI guard；MR !4760 更新为双站描述。不改变生产部署。

### OpenCraft 套餐入口兼容（2026-09-29）
- 目标：兼容本轮套餐与费用跳转，合并最新 master 并更新原 MR；不移植网页总览布局到桌面、不发布客户端。
- 精确路由首次 query `opencraft Agent Console overview billing compatibility` 未命中；按 `opencraft/plugins/lightvela-hermes` 命中后读取 OpenCraft 服务、agent-gateway-runtime、site-environment-routing、upstream-subtrees 与 opencraft/AGENTS。补读 MONO2_MIGRATION、维护技能/验证清单、platform-architecture 的账户章节、frontend-runtime-openspec-i18n 邻接卡；检查 sync-mono2-agent-console 的同步种子及相邻测试。
- 实际入口在 lightvela-platform，账户管理订阅与额度阻塞恢复由旧 `/account?tab=billing` 改为 `/account/billing`，按账号区域选择域名；保留外部页面返回后的刷新机制。
