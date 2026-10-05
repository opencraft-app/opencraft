---
id: cloud-desktop-master-delivery
type: task
scope: 提交云桌面完整实现，融合最新源码主线并推送。
triggers: ["云桌面合入", "cloud desktop master delivery", "云桌面源码提交"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "docs/engineering/domains/agent-gateway-runtime.md"]
status: active
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
按用户“提交，推送合入 master”的授权，交付此前开发的完整云桌面源码与测试，并保留最新主线能力。

## non_goals
不重启、替换当前预览，不发布 GitOps、不同步公共镜像，不创建云资源或扩充生产输入授权。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；用户明确要求提交、推送与合入 master，随后要求继续。

## interface_refs / data_structure_refs
Desktop contract 与 Host Desktop capability、本机 Thread 授权服务、CTL desktop resource、Sandbox desktop broker；远端 SSH binding 不拥有本机 desktop 服务，不能继承上游虚报的本机扩展或转发其 RPC。

## history_context
current_design_refs：opencraft/docs/cloud-desktop-plugin.md、opencraft/docs/platform-architecture.md、docs/engineering/domains/agent-gateway-runtime.md、docs/engineering/journeys/agent-request-streaming.md。
relevant_evolution：原实现工作区提交为 0f6b4f647；独立融合工作区以 origin/master ebba1eacf 为基线，保留主线 SSH、附件 staging、异步回答与全局焦点模型。
superseded_refs：先前云桌面 Task Pack 仅为各阶段历史收据，不能作为当前线上版本证明。

## acceptance / validation
实际融合后的源码通过相关服务测试、OpenCraft 完整门禁或明确记录失败边界、Web 构建与桌面浏览器回归；实际暂存集合通过设计映射与敏感信息检查；非强制推送并核实远端 master 包含功能提交。

## affected_paths / scan_scope
opencraft、ctl、sandbox、service-gateway、映射设计文档与本轮交付 Task Pack。原工作区未提交的全局 catalog 漂移不带入；融合工作区独立生成目录。

## context_receipt
根/OpenCraft/CTL/Sandbox/Service Gateway AGENTS；OpenCraft maintenance skill 与完整 verification；Task/Checkpoint 模板；frontend-runtime-openspec-i18n 邻接与实际 check-i18n 邻居。路由查询 `opencraft 云桌面 提交 推送 合入 master 源码 不发布` 无匹配，随后对实际 Git 变更、冲突与测试做有界检索。融合时核对最新主线 AGENTS 差异并保留新增约束。

## decisions / risks
独立 worktree 融合，不 reset/stash 用户工作区。13 处冲突按两边所有权保留而非选整份 ours/theirs。Desktop 仅加入 LocalCodexEngineOptions；RemoteCodexEngineOptions 不得到本机服务。共享原生 initialize 投影删除 desktop 扩展，测试注入伪造上游扩展并确认两客户端都不宣告；远端 create/release 也不能转发。正式设计保留主线 Bot/预热变更与新桌面段。Owner review 由平台执行，不绕过分支保护。

## evidence / handoff
融合工作区已独立 npm ci，固定 noVNC 绘制/剪贴板事件补丁验证成功。CTL 全包、Sandbox 全包、Service Gateway internal/gateway 测试通过。融合后的 Codex adapter、SSH routing/native surface、headless 共 50 项通过；Web 构建通过，包含 rfb-DG7aOt7u.js。功能分支已推送；融合提交与 master 推送待核对。未部署。

- 完整 gate 通过 i18n、全 workspace typecheck、平台边界、92 项桌面测试及 Electron launch 后，在 pretest:extensions 的 pinned artifact 回滚断言失败；测试未回收资源而挂起，主动停止。独立未改动的 master ebba1eacf、独立 npm ci 复现同一 artifactRef 差异，60 秒截止退出 124。本轮未修改相关实现与测试，不把此门禁写成全绿。
- 单独执行扩展主测试（明确不执行已失败的 pre-hook）221/221、协作 workspace 76/76 通过。其余 gate 各项逐一执行：connectors、appserver/SSH、projects、thread lifecycle、speech、AppServer lab、chat、workbench、shell、workspace presentation、environments、desktop login、headless、web release 全部通过；Web、Expo Web/iOS 构建通过。SSH 真实 runtime 用例有一个既有 skip，未当成执行通过。
- 初次 DSH 测试缺失独立 runtime 包导致 4 项失败，未改 master 同样复现。按锁执行 prepare:dsh-runtime 后复跑 245/245 通过；没有借用其他 checkout 的 node_modules。
- 共享控件标准 18/18 通过。真实 noVNC 的普通及扩展剪贴板 browser smoke、当前构建 CSS 的 panel smoke（亮/暗/自定义主题 × 720/320、tap、减少动画）通过。浏览器后端/media 边界仍有替身，不宣称生产安全或手机实机验收。
- 文档验证 0 errors，实际暂存集设计映射通过；120 文件的已知凭据、私钥材料与 cloud key 有界扫描无发现，不是全历史安全审计。完整命令日志留在 /tmp/opencraft-master-delivery-checks-yoG8VJ（私有临时目录），不提交日志。
- 根 context 单测 27 项仍有 4 项失败，在未修改 master 的独立工作区同样复现；全局 validator 5810 项报错，其中既有 desktop-assessment 缺元数据，不属于此次暂存变更。新交付 Task Pack 和重建 catalog 报错 0；context audit 单测 33/33，发现报告 not_assessed，不伪造质量评分。

## checkpoint
stage：功能分支已推送，融合树回归完成，等待提交并核对远端主线。
verified：上述服务测试、桥接回归、Web/Expo 构建、桌面浏览器验收及基线失败对照；原始工作区仅留下既有 catalog 漂移。
unverified：远端主线状态与平台 Owner review；完整 gate 有已复现的主线失败；生产 authority/executor/手机实机沿用前任务未验收边界。
discard：此前工作区测试不是本次融合树门禁，未用它替代当前验证；没有执行 GitOps MR 发布助手。
next_action：提交融合并按保护规则推送，核对远端后关闭本任务收据。
