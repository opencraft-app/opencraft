# SSH 远程附件上传

## goal
按 ref/codex 的远程文件行为补齐 SSH Host 上传、重试、删除、模型可读引用及历史展示。

## non_goals
- 不改本机模型、账号、远端 Codex 服务安装或启动方式。
- 不提交、推送；当前服务发布与重启沿用会话授权边界，先完成可审查的候选。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前会话：用户指定参考 ref/codex，随后明确要求“完整复刻搞起来”。

## interface_refs / data_structure_refs
- attachment/stage、attachment/remove 与 AttachmentRef 保持共享协议。
- SSH 已保存的认证与主机信任由后端持有；远端路径不得当作本机路径。

## history_context
- current_design_refs：opencraft/docs/chat-ui-architecture.md、platform-architecture.md、docs/engineering/domains/agent-gateway-runtime.md。
- relevant_evolution：RemoteCodexEngineOptions 不提供 staging；native projection 与 admission 均拒绝附件扩展。
- superseded_refs：ref/codex 为恢复的 Renderer 参考，无产品版本元数据；只借鉴已读调用链。辅助 Main bundle /data/codex-current-ref/package.json 标识 26.831.21537，不冒称与恢复 Renderer 同版本。

## acceptance
- 小文件 RPC、超过 10 MiB 文件 SFTP，32 MiB 上限保持；远端保存字节校验一致。
- ready 只发生在远端提交后；断线重试幂等，冲突拒绝；删除可重试，已发送资源保留。
- Draft 与 Thread 共用 resolver；发送传远端路径，刷新和 fork 保持附件历史。
- 真实浏览器与隔离 Host 测试；目标机器使用专属验收附件，不调用推理或删除用户文件。

## affected_paths
- opencraft/apps/opencraft-daemon/src/ssh-*、codex-engine-adapter.ts
- opencraft/apps/local-agent-host/src/attachments/local-attachment-staging.ts
- opencraft/scripts/headless-server.mjs、相关 tests 和正式设计文档。

## required_context
- 路由未匹配，先有界搜索；已读维护 Skill、验证清单、平台与 Chat 架构、根及 OpenCraft AGENTS。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、opencraft/AGENTS.md | 工作边界 | 保留前序改动及授权 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md、references/verification.md | 实现与验收 | 真实链路及失效所有权 |
| opencraft/docs/platform-architecture.md、chat-ui-architecture.md | 平台与附件契约 | 共享接口、Host 资源和历史 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md、frontend/vitest.config.ts | 邻接检查 | 实际测试入口 |
| docs/context/tasks/2026-10-04-opencraft-ssh-codex-compatibility.md、2026-09-21-opencraft-local-attachment-staging.md | 历史 | remote admission 与幂等边界 |
| /data/mono2-source-main-20261009/ref/codex/features/editor/attachments-registry-filename.ts、editor/upload-local-file-attachment-09977.ts、upload-file-attachment-09979.ts | 指定参考 | 10 MiB RPC/SFTP、远端目录、失败清理 |
| /data/codex-current-ref/main-7MZ5kTIG.js、package.json | SFTP 边界 | 原生 sftp batch 和密码认证差异 |

## evidence
- 源码及实际运行 bundle 对 Remote 均设置 attachmentStaging=null。
- ref/codex 小文件 fs/writeFile；SSH 大于 10 MiB 或大小未知走 SFTP。

## risks
- SFTP 缺失/不兼容时错误保留；不静默塞大文件到 RPC。
- 未确认的远端写入保留可恢复记录，不自动删除可能已提交的资源。

## validation
- 新增 staging/SFTP/broker 聚焦测试最终 9/9 通过：RPC/SFTP 选择、32 MiB、未知提交重试、冲突、并发、删除重试、已发送保护、重开与 Fork。
- test:appserver 主体 258/258；集成的 SSH 测试 83 通过、1 跳过（本机 sshd 运行条件）；Headless 31/31、bot-management 32/32 通过。
- opencraft-daemon、local-agent-host、workbench-runtime typecheck，boundaries、文档链接和具体 changed-file 正式设计影响检查通过；git diff --check 通过。
- 真机 9.134.163.40 的原生 initialize、文件接口与密码 SFTP 探测通过。1 KiB、13 MiB、32 MiB 上传、独立 SFTP 回读 SHA-256、幂等重试、删除和超限保留连接通过；没有推理。
- 源码服务与最终候选包均完成真实 Chromium + 远程 Codex Draft 上传；最终候选也验证通过 UI 删除三个附件，零 pageError。专属验收文件已清理。
- 将 switch 后使用的完全相同 verifier 在独立候选上先运行，已通过；使用 `/ssh-apphost` 私有入口和服务端 Session Cookie，不绕过鉴权。
- 独立切换完成后，线上 AppHost 对真实远程机器的 1 KiB、13 MiB、32 MiB 上传、独立 SFTP 校验、幂等重试、删除及超限保留连接全部通过；后续当前进程复验也全部通过。

## decisions
- 保留统一协议，在 SSH 后端增加资源 owner；凭据不进入 Renderer。
- 私有后端按 Server 与端点隔离元数据；远端 CodexHome 以 initialize 为准。

## scan_scope
- SSH transport、broker、附件协议、本地暂存、指定参考和聚焦测试。

## scan_output
- 不输出真实凭据；专属验收目录在 /data/opencraft-ssh-attachment-20261010。

## handoff
- 已完成实现、应用和独立服务重启，沿用本会话已明确的“应用”和重启授权。源码、真机、真实浏览器、隔离候选和线上服务验收均通过。没有提交或推送。
- 候选保留正在运行 bundle 的全部现场修改，只增加内容寻址的 SSH 附件模块和九处精确接入点。候选 runtime SHA-256 为 dd01fde505b8038bdbc959b35fec68348682bf338b4073c170b3aad37f7cc6e7。
- 切换、原 bundle 备份、候选、浏览器及运行时验收证据保存在 /data/opencraft-ssh-attachment-20261010/；失败回退由独立 systemd 任务负责。

## checkpoint
- 2026-10-10：用户已授权完整实现；当前 dirty tree 为前序自动连接和 WebSocket 限额修改，保留。
- 原生 SFTP 批处理强制 BatchMode=yes，普通参数不能恢复密码认证；已通过私有固定 SSH wrapper + 既有 askpass IPC 接通，实机验证通过。
- 构建候选时纠正 shebang/import 顺序与独立模块 ws 依赖打包；最终候选启动和真浏览器通过。Verifier 首次经匿名 /apphost 入口被正确拒绝，改为私有 /ssh-apphost 后隔离验收通过。
- 切换前 owner 重新核实为 PID 739751，unit/cgroup/cwd/80 端口一致，当前 runtime 仍为上一轮 d56833fd5dd39e3f7a1de797cc5527ddaa18914aaee736f3281de58530048b98；Web buildId 为 20261010-local-codex-auto-412571440ce9。本轮 Web 产物保持不变。
- 独立切换结果为 complete，切换后 PID 981286；后续进程 PID 1152371 的 unit/cgroup/cwd/80 端口归属再次核实一致，runtime 与 SSH 模块哈希均匹配候选。2026-10-11 再次运行线上 verifier 全部通过，无需再次重启。结果与证据见 switch-result.json、live-verified.json。
