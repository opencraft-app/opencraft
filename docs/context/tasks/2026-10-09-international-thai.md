---
id: task-international-thai-20261009
type: task
scope: Add complete Thai localization to the LightVela international site.
triggers: ["Thai", "th-TH", "international Thai"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - frontend/src/i18n/locales.json
  - frontend/src/i18n/index.ts
  - frontend/src/content/docs/th
status: active
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.0
precedence: task
derived: false
---

## goal
从最新 master 新建分支，参考马来语实现，为国际站增加完整泰语（th-TH / th-th）产品界面、公开页面与文档。

## non_goals
- 不改生产、GitOps、云资源、计费或外部账户；不自动合并 MR。

## requirement_refs / requirement_excerpt
- 用户：“起一个新的分支，增加一个泰国语的版本吧。参考马来语的实现。”
- https://git.woa.com/wisp/mono2/-/merge_requests/5133
- !5133 已合并，技能分类无条件调用马来语词典造成其他语言页面崩溃。必须只在当前语言分支消费对应词典，保持非目标语言无需加载目标目录。

## interface_refs / data_structure_refs
- frontend/src/i18n/locales.json：语言、公开路由、翻译门禁唯一注册表。
- frontend/src/i18n/index.ts：异步字典与公共词典加载完成后切换；代次约束晚到结果。
- frontend/scripts/sync-fumadocs-content.mjs：文档输出和 metadata。
- opencraft/apps/workbench-web/src/i18n/catalogs.ts：嵌入式工作台 locale。

## history_context
- current_design_refs: docs/engineering/domains/site-environment-routing.md；docs/engineering/domains/agent-gateway-runtime.md。
- relevant_evolution: !5116 马来语完整支持；!5133 按 locale 延迟消费技能分类；最新 master 1667fea443（含 !5137 CI 共享依赖复制）。
- superseded_refs: 马来语开发时的旧 CI 安装失败，不能照搬旧 guard。

## acceptance
- 泰语完整字典、独立文档源、公开页面、语言选择、搜索、SEO 与嵌入式工作台可用。
- 国内及其他语言不加载泰语公共词典，也不因其未加载而失败。
- 非空格泰语词检索能命中文档；文档代码、链接和字段标识不被翻译。
- check、聚焦测试、双站构建、工作台 ICU 检查与机械同步检查通过。

## affected_paths
- frontend/src/i18n；frontend/src/content/docs/th；frontend/next-site；frontend/scripts；frontend/src/pages/marketing；frontend/src/components/site。
- opencraft/apps/workbench-web/src/i18n；机械同步的 plugins/lightvela-hermes/src/upstream/mono2。

## required_context
- site-environment-routing；agent-gateway-runtime。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md | 根约束 | secret、验证、TaskPack、交付授权 |
| frontend/AGENTS.md | 前端约束 | check/test/build、真源先提交再机械同步 |
| opencraft/AGENTS.md | 工作台约束 | 独立依赖和语言目录 |
| docs/context/domains/site-environment-routing.md | router must_read | 国际/国内边界 |
| docs/context/domains/agent-gateway-runtime.md | router must_read | 嵌入式工作台所有权 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 语言邻接 | 检查 locale 与测试邻居 |
| frontend/DESIGN.md | 泰语字体呈现 | 复用现有语种字体栈 |
| docs/context/tasks/TASK-TEMPLATE.md | 任务 contract | 本记录 |

## evidence
- 独立 worktree /data/mono2-thai，branch codex/lightvela-thai，baseline 1667fea443。
- 工蜂只读 API 获取 !5133 描述和讨论；已确认真实技能分类 locale 分支修复。

## risks
- 翻译占位符、Markdown、ICU 参数须结构验证；翻译完整不代表经泰语母语编辑审核。
- 公开首页采用英文结构加提交目录机械生成；必须检查遗漏译文。
- 泰语需 Unicode 词分段与字体回退；不复用汉语分词器。

## validation
- 前端 check、聚焦回归与 CN/global builds；OpenCraft check:i18n、embedded-ci、readonly sync；文档影响检查。

## decisions
- 沿用已有按语言按需加载与独立文档源，不引入平行 UI 或旧 SDK 桥接。

## scan_scope
- frontend locale/Next/public/marketing/scripts；opencraft i18n。

## scan_output
- 临时翻译与验证日志在 /tmp/lightvela-thai-*，不含 secret。

## handoff
- 正在实现与验证；后续沿用本会话已授权的 commit/push/MR 交付流程，未授权自动合并或发布。

## checkpoint — 实现与翻译中
- stage: 独立分支编码完成主要接入，翻译与完整门禁仍在进行。
- verified: 工蜂 !5133 描述/讨论与源码确认；语言注册/公开路径/搜索端点 3 文件 41 测试通过；Thai Orama 查询/保存重载与其他分词回归 8 测试通过；独立 frontend pnpm install 与 opencraft npm ci 已完成。
- unverified: 全部 8,775 段翻译队列未结束；首轮 typecheck 新增诊断包含尚未生成 Thai docs manifest、尚未写入 Thai blog 和测试语言穷举两处，须完备后重跑。浏览器与双站构建未执行。
- discard: 初始公开语言测试批量替换造成对象语法错误已修复并重跑通过，不能采用初始失败日志作为最终结果。
- restore: /tmp/lightvela-thai-translation.log、/tmp/lightvela-thai-cache.json、/tmp/lightvela-thai-finish.py、/tmp/lightvela-thai-doc-parts.json、/tmp/lightvela-thai-code-copy.json、/tmp/lightvela-thai-fuma-cache.json。
- next_action: 等翻译结束合并 docs chrome cache，再严格生成所有目录，补测试语言穷举并执行 check 与回归。

## checkpoint — 完整资源与聚焦门禁通过
- stage: 全部 Thai 资源落盘，双站构建与浏览器验收待执行。
- verified: UI 3,050；公共 copy 1,389；首页 621；73 文档源；222 工作台消息；98 博客文本。ICU/参数检查、工作台 embedded-ci 222/222、平台边界检查通过。前端 check 164/171、0 new/7 resolved；最终 Thai 字典 3,050/3,050、0 错误/0 告警。13 文件 245 用例完整回归通过。
- unverified: 隔离 guard 首轮因文档 parity 语言期望未补 Thai 而失败；已补 fixture，正在复验并将重跑完整 guard。浏览器与双站构建、生成副本同步及远端 CI 尚未验证。
- discard: 英文结构翻译时的三处 Markdown 链接已修正，严格 73 文档代码/inline/link 测试通过；初始日期已按 UTC 校验约定修正。此前未生成文档 manifest 时的类型/SEO 失败不代表最终结果。
- restore: /tmp/lightvela-thai-focused-final.log；/tmp/lightvela-thai-docs-recheck.log；/tmp/lightvela-thai-check.log；/tmp/lightvela-thai-icu.log；/tmp/lightvela-thai-embedded-ci.log；/tmp/lightvela-thai-validation/cases.json。
- next_action: 完整 guard 正确重跑，保留国内输出用于实际浏览器矩阵，并验证最新 master 后提交真源及机械生成层。

## checkpoint — 最新 master 集成
- stage: 已合并 master 55073abc04；两份 runtime 文档内容冲突按职责保留双方内容。
- verified: Thai UI 补齐至 3,060 条；新协作功能与 locale/SEO 11 文件 111 测试通过。文档 parity 45/45；Markdown 末尾空行规范化，保留合法硬换行。
- unverified: 最终隔离 frontend guard 正在执行；浏览器矩阵、生成层与远端 CI 尚待验证。
- restore: /tmp/lightvela-thai-master-regression.log；/tmp/lightvela-thai-frontend-guard-complete.log。
- next_action: 提交补齐文案，再执行机械同步并验收完整构建与浏览器。

## checkpoint — 浏览器发现文档入口与弹窗语言问题
- stage: 国内/国际两轮构建通过，真实浏览器已复现手机文档导航被公开顶部栏遮挡及搜索弹窗 UI 保留英文。
- verified: 已启用 Fumadocs 移动导航并预留 60px 顶部空间；泰语搜索结果正确。新弹窗逻辑共享语言目录并按路径提供 locale。
- unverified: 弹窗组件测试的前三轮因测试 FrameworkProvider/JSX harness 缺失失败，不能据此声称测试通过；正在补齐真实 Provider 和测试 JSX 环境。最终构建与浏览器须覆盖这些新修复。
- restore: /tmp/lightvela-thai-validation/search-probe.log；/tmp/lightvela-thai-search-chrome-tests.log；/tmp/lightvela-thai-frontend-guard-verified.log。
- next_action: 修正测试 harness，完成最新代码的门禁与 10 用例真实验收再交付 MR。

## checkpoint — 搜索弹窗本地化完成
- verified: 真实 FrameworkProvider、真实搜索 Dialog 与默认英文外层环境下，泰语/英文弹窗标签回归通过；3 文件 12/12 测试通过。测试所需 JSX 全局及 ResizeObserver 已在测试局部提供并清理。
- unverified: 最新搜索 UI 修复还需最终 19 文件 guard、双站构建与真实浏览器复验。
- next_action: 运行最终完整门禁；通过后更新验收证据、提交分支并创建 MR。

## checkpoint — 本地验收完成，准备 MR
- stage: 最新代码的完整隔离 guard 与真实浏览器验收均通过。
- verified: Node 22.12.0 / pnpm 10.32.1 frozen install；19 文件 267 测试；Thai 3,060/3,060、0 错误/0 告警；typecheck 164 当前 / 171 基线、0 new / 7 resolved；CN/global 完整 static builds，SEO 8/58 路由检查通过。OpenCraft ICU、222 embedded-ci、平台边界及 136 生成文件只读一致性通过。最新 master 功能与 locale/SEO 111 测试通过。正式文档和变更影响检查通过。
- verified_browser: Chromium 140，桌面 1440×960 / 手机 390×844，10/10 用例通过；Thai 搜索“โมเดล”命中并导航至 Thai docs；搜索弹窗占位与关闭按钮本地化；语言切换保持文档进入英文 canonical 路径；英文/国内无 Thai 字典请求，国内无 Thai 路由。截图已查看，字体正常且无明显横向溢出。
- source_revision: d2b246f303861e8ce33576da48c96995aa93f426；本提交仅更新验收记录。
- unverified: 尚未在此记录创建时间完成远端 CI；未合并、未生产发布，未验证真实账号、支付、付费模型及泰语母语编辑审核。全仓 Vitest 与全量历史 context 审计不能用聚焦门禁代替。
- restore: /tmp/lightvela-thai-frontend-guard-delivery.log；/tmp/lightvela-thai-master-regression.log；/tmp/lightvela-thai-embedded-final.log；/tmp/lightvela-thai-validation/report.html；/tmp/lightvela-thai-validation/report-data.json。
- next_action: 沿用会话授权 push codex/lightvela-thai 并创建 MR，核对新 HEAD 远端 CI 与合并状态；不自动合并或发布。

## checkpoint — 远端 CI 失败与本地复现
- stage: MR !5146 已创建，HEAD 52106d8d9a，工蜂状态 can_be_merged；首轮 MR 占位检查 failure，耗时 1m27s。
- context_receipt: 新读取 .ci/AGENTS.md、docs/context/flows/tapd-gongfeng-delivery.md、docs/context/project/services/ci.md、.agents/skills/devops-pipeline/SKILL.md。
- verified: 完整 ci-runtime 本地复现 656 tests：唯一失败 test_beijing_gateway_consumes_dedicated_collaboration_bridge_secret。master 17ba518fce 已加入 https://lightclaw.pages.dev 来源，但测试期望仅 localhost。修复仅更新精确名单断言，保持 token env/upstream/全部来源的完整比较；不改配置、部署或权限。
- unverified: BK_CI_ACCESS_TOKEN 未配置，已按技能请求日志读取授权；本地复现不能等同读取蓝盾日志。新断言修复需完整 ci-runtime 与远端新 HEAD 复验。
- restore: /tmp/lightvela-thai-ci-runtime-reproduce.log；MR !5146；/tmp/lightvela-thai-validation/report.html。
- next_action: 完整 ci-runtime 通过后推送同一 MR，并核对新的远端 CI 状态。

## checkpoint — 上游 CI 契约修复验证通过
- verified: 完整 ci-runtime 656 tests 通过（4 个既有 skip），materialized runtime smoke、YAML/manifest 与 diff 检查全部通过；完全按 CI 入口隔离 npm ci --ignore-scripts 的 opencraft guard 222/222 通过，包含生成层只读检查。
- next_action: 推送精确名单测试修复到同一 MR !5146，核对新提交 SHA 的远端 CI；浏览器与产品代码仍为已验证 d2b246f303，不涉及新产品实现变更。

## checkpoint — !5146 CR 与 master 冲突修复
- request: 用户要求查看 !5146 会话 CR 并处理合并冲突，沿用本会话已有 commit/push/MR 授权。
- context_receipt: AGENTS.md、frontend/AGENTS.md、opencraft/AGENTS.md、site-environment-routing、tapd-gongfeng-delivery、frontend-runtime-openspec-i18n 邻接卡和 gongfeng/cloud runtime 技能。
- verified: 工蜂 API 读取全部会话；最新 master 3b6cbe9127，唯一冲突为 UPSTREAM.json，采用同步脚本重新生成并合并 master。
- changes: 泰语建议条明确 Thai；FX 默认参数保留 USD/CNY；越南 19/2023/QH15 与 20 June 2023、肯尼亚 2012 法规保留公历编号年份。补实际建议条交互、FX dropdown 参数、法律引用与 Thai SEO 前缀回归。
- failed_queries: 初始精确路径 thai-public-copy.json 与 scenario* tests 无结果，已改查 generated/ 与实际 __tests__；不将检索失败当作验证失败。
- unverified: 新代码 check/tests/build、最终机械同步和远端 CI 尚待复验。
- next_action: 完成门禁，提交真源后独立同步，推送同一 MR；不自动合并或发布。

## checkpoint — CR 真源回归通过
- verified: Node 22.12.0 固定环境 pnpm check 通过，Thai 3,062/3,062、0 错误/告警；TypeScript 164 当前/171 基线、0 新增/7 消除。4 文件 69 项测试通过，旧建议条/FX/法律错误重新注入后三条新回归均 RED。文档校验通过。
- unverified: 22 文件完整 guard 与双站构建仍在执行，最终机械同步和新 HEAD 远端 CI 未完成。
- next_action: 提交 frontend 真源并独立生成同步副本，等待完整构建完成再推送同一 MR。
