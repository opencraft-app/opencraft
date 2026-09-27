## goal
给已连接的 Hermes 通道提供一次性测试消息发送入口，并在发送期间锁定通道连接操作。

## non_goals
- 不把发送成功解释为用户已收到或双向消息链路已验证。
- 不改变 ACLI、Hermes 或 CTL 的通道实现，也不自动断开或重连通道。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮请求：已连接通道显示“测试”；触发后发测试消息；成功后提示前往聊天软件确认；失败时统一重试指引且不暴露底层错误；检测期间禁止断开与重新连接。
- 后续明确要求：测试发送不再使用 ACLI，直接参考定时任务弹窗的 Hermes `send` 和 Profile 路由模式。
- 后续明确要求：失败提示同时建议检查通道连接，或重新连接通道后再次测试。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-config/hermes-command-builder.ts`：按 Profile 构造 Hermes 测试发送命令。
- `frontend/src/pages/marketing/agent-config/hooks/useChannelOperations.ts`：通道操作与互斥状态。
- `frontend/src/pages/marketing/agent-channel-panel.tsx`：已连接卡片与反馈。
- Hermes `send --to <platform> --json --file -`：JSON 中的 `success` 表示 Hermes 是否接受发送。

## history_context
- `current_design_refs`：`frontend/AGENTS.md`、`docs/context/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：现有前端以 `acli channel status` 展示连接状态，其 `connected` 是配置语义，不保证实际送达。
- `superseded_refs`：无。

## acceptance
- 仅已连接卡片显示测试入口，命令携带所选平台，并通过 `hermes -p` 指定当前 Bot Profile。
- 测试中阻止测试重复触发以及连接、重连和断开动作。
- 成功只提示用户到聊天软件确认；失败采用固定文案，建议检查连接或重连后再次测试，且不显示 Hermes 错误。
- 聚焦交互测试、命令构造测试和前端门禁通过。

## affected_paths
- `frontend/src/pages/marketing/agent-channel-panel.tsx`
- `frontend/src/pages/marketing/agent-config/hooks/useChannelOperations.ts`
- `frontend/src/pages/marketing/agent-config/hermes-command-builder.ts`
- 对应测试、样式与 i18n 生成文件。

## required_context
- `agent-gateway-runtime` Domain Pack；前端服务级 `AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@origin/master` | 通道与运行时边界 | 限定为前端入口，不冒称传输验证 |
| `docs/context/project/services/frontend.md` | 前端服务边界 | 确认双站共用实现和最小验证 |
| `docs/context/domains/site-environment-routing.md` | 双站路由边界 | 区分本地预览与生产发布 |
| `frontend/AGENTS.md@origin/master` | 前端验证与 UI 约定 | 复用现有组件、执行前端门禁 |
| `docs/context/tasks/TASK-TEMPLATE.md@origin/master` | Task Pack 格式 | 记录本轮目标与证据 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | 前端邻接 | 检查相邻测试与 i18n |
| `frontend/DESIGN.md@origin/master` | 现有按钮与布局规范 | 沿用卡片内胶囊按钮、保持操作区换行 |
| `frontend/openspec/changes/2026-08-30-automation-test-send-error-copy-design.md@origin/master` | 既有发送失败文案约束 | 不展示原始 Hermes 错误 |
| `opencraft/AGENTS.md`、`opencraft/MONO2_MIGRATION.md` | OpenCraft 生成边界与验证 | 由 frontend 真源同步 vendored 闭包 |
| `docs/context/project/upstream-subtrees.md`、`docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻接与生成契约 | 核对生成脚本、翻译资源及检查入口 |
| `docs/context/flows/tapd-gongfeng-delivery.md`、`.agents/skills/gongfeng/SKILL.md` | 现有 MR 交付 | 使用既有分支并核验远端状态 |

## evidence
- MR !4678 的 `MR 占位检查` 在 OpenCraft guard 失败：`i18n/generated/en-US.json` 的前端源文件与 vendored 副本 SHA 不一致。下载的失败步骤日志为 737 行；本地 `npm --prefix opencraft run check:mono2-agent-console` 复现相同错误。按官方同步脚本生成 130 个文件的闭包，仅 13 个受本次前端提交影响的 vendored 文件出现差异；同步后闭包检查通过。
- OpenCraft 依赖安装后，`@opencraft/plugin-lightvela-hermes` typecheck、`check:i18n` 与 `.ci/checks/opencraft_guard.sh` 均通过；CI guard 确认 130 个 vendored 文件一致。
- 同步提交推送后，工蜂 MR !4678 指向新 SHA 但因目标 `master@10491fb09` 前进而显示不可合并；`git merge-tree` 确认唯一冲突是生成的 `UPSTREAM.json`。将目标版本作为基线并重新执行同步脚本，合并提交 `88cbf3a6a` 后再次同步，使 `sourceRevision` 指向合并提交；闭包检查与插件 typecheck 通过。
- 合并后前端 `pnpm check` 通过（TypeScript 当前 171、基线 171、新增 0），通道聚焦 Vitest 5 文件 19 项通过；OpenCraft `check:i18n`、插件 typecheck、vendored 闭包检查通过。
- 用户提供的 MR !4678 CR 指出配置侧互斥测试使用了不支持手动配置的飞书，无法证明守卫有效；现改用列表内的钉钉和完整凭据，第二次命令 mock 可完成。补充绑定、断开在 `restartAndRefresh` 未完成时保持互斥，以及执行结果失败但输出声称成功的反例。通道聚焦测试 5 文件 22 项通过，`pnpm check` 新增 TypeScript 诊断 0。
- 清理五本人工翻译字典中已无源码映射的 QQ、钉钉旧“推荐”文案键；与 `zh-CN` 的键集均为 3056 项且完全一致。
- CR 修复后并入当前 `master@eb01247e5`，唯一冲突仍是生成的 `UPSTREAM.json`；以目标版本为基线重新同步，合并提交 `a8fea1f84` 后再次生成版本记录。合并后通道聚焦测试 5 文件 22 项、`pnpm check`（171 当前/171 基线/0 新增）、`pnpm build:cn`、`pnpm build:global`、OpenCraft 插件 typecheck、`check:i18n` 与 130 文件闭包检查通过；构建字体差异已恢复。
- ACLI 发布包 `2026.09.22-1` 的 Hermes LightVela spec `1.1.28` 含 `channel/send`；要求 `--platform` 和 `--message`，成功结果 `data.status = sent`，最低运行时 `0.15.0`。
- 本地预览连接上海正式后端的 QQ 实例，两次失败的 debug/exec 回执均为 `unknown flag: --agent`；发布包的 `channel/send/capability.yaml` 确认没有 `agent` 参数。修正后浏览器显示“测试消息已发送”，代理记录 HTTP 200 且 ACLI 输出 `data.status = sent`；实际 QQ 客户端接收仍待用户确认。
- 修正后的命令构造与 Hook 聚焦测试 2 文件、7 测试通过；`pnpm check` 通过（TypeScript 诊断 171，与基线相同，新增 0）。
- 改走 Hermes 后，命令构造、Hook 和交互聚焦测试 3 文件、10 测试通过；`pnpm check` 通过（TypeScript 诊断 171，与基线相同，新增 0）。Chrome + Whistle 5274 预览复测已连接 QQ：请求命令为 `hermes -p 'default' send --to 'qqbot'`，未调用 `acli channel send`；后端 HTTP 200，Hermes JSON `success: true`，页面显示发送成功。
- 最新代码的 `pnpm build` 通过，`/agents/channels` 静态路由已生成；构建后重启 5274 开发服务器，HTTP 200 且 Chrome 中已连接 QQ 卡片正常呈现。构建产生的字体文件差异已恢复，`git diff --check` 通过。
- 聚焦 Vitest：5 文件、17 测试通过；相邻通道样式/钉钉测试：2 文件、8 测试通过。
- `pnpm check` 通过：当前 TypeScript 诊断 171、基线 171、新增 0；`pnpm build` 通过；文档校验无断链、无未分类文档；`git diff --check` 通过。
- 全量 `pnpm test` 在多个与本次改动无关的测试文件报错后，有一个 worker 持续运行超过三分钟，已停止本次运行；未获得全量通过结论。其中 Slack 静态断言要求旧文案“绑定”，而 HEAD 中当前文案为“连接”。

## risks
- 旧 Hermes 如不支持 `send --json --file -`，按统一失败反馈处理。
- `hermes -p` 的命名 Profile 路由已有定时任务实现与单测作参照，尚未用真实命名 Bot 发送验证。
- 发送成功不等于送达；成功文案要求用户在聊天软件确认。

## validation
- 前端聚焦测试、`pnpm check`、`pnpm test`、`pnpm build`、i18n 检查与 `git diff --check`。

## decisions
- 复用当前通道卡片和命令执行器，不增加后端接口。
- 根据用户后续指示，测试发送改用 Hermes CLI `-p <profile> send --to <platform>`；消息通过 stdin 传入，JSON `success` 与执行结果共同判定成功。连接状态查询和通道配置命令仍走现有 ACLI 路径。
- CR 提到的绑定、断开 loading 会持续到重启结束，这是为防止重启期间并发连接操作而保留的有意时序；通过 held-promise 测试固定，并在 MR 描述中提示 QA 回归。Task Pack frontmatter 建议不属于本次功能或现有模板正文要求，暂不扩展。

## scan_scope
- `frontend/src/pages/marketing/agent-config/`、`agent-channel-panel.tsx` 和相邻测试、样式。

## scan_output
- 有界 `rg` 定位到 `useChannelOperations`、命令构造器和通道卡片；无独立扫描产物。

## handoff
- 本地实现与聚焦验证完成；已在用户已连接的主 Bot QQ 通道通过 Hermes 发送一次测试消息，CLI 返回 `success: true`，客户端收信由用户确认。用户已授权提交 MR；远端状态以最终交付回报为准，未授权合并或发布。
