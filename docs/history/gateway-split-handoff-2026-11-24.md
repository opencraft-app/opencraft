# Handoff：Gateway 拆分与多部署形态（2026-11-24）

> 会话：https://claude.ai/code/session_01Y38KYMhFhrudoc5yoCNC5r
> 本文件未提交到 Git（放在主 checkout 根目录供阅读）。权威设计文档见 `docs/architecture/platform/gateway-split.md`、`cloudflare-deployment.md`、`storage-ports.md`、`workspace-host-split.md`。

## 1. 目标与原则

- 同一套领域代码装配到多种部署形态：Node 自托管（Docker／systemd／Electron，一等公民）与 Cloudflare（Workers＋DO＋Containers，可选）。
- **不为 CF 特化**：CF Worker 是最弱运行时，通用 contract 以它为底线；领域只依赖中立端口，Node 与 CF 是对等适配器。只有部署装配目录（`apps/headless-server/src/cloudflare/`、`deploy/cloudflare/`）按平台命名。
- 长期所有权优先，不做 workaround；纯重构保持构造顺序、求值时机、关闭顺序字面不变，并先在基线上提交钉住行为的测试。

## 2. 总体进度（粗估）

| 方向 | 进度 | 说明 |
|---|---|---|
| 中立端口（SQL、HTTP exchange、client-session、owner-wake、根输入、commit fence） | ~95% | 已合并 |
| 部署级存储迁到 `SqlDatabase` 端口 | ~95% | 领域存储全部迁完；剩跨进程只读读者（按设计在 CF 上改为向 owner 发 RPC） |
| G1 组合根拆分（`apps/headless-server/src/assembly/`） | ~100%（待 #583/#590 合并） | 七个模块全部抽出；HA 只剩配置读取、Node 工厂、模块调用与关闭顺序 |
| 可靠性（内核单写者锁、到期调度） | ~90% | 剩 Host 侧 token usage 投影 |
| InstallationCore DO | ~50% | 身份、登录、准入、会话已通；协作、spaces、connectors、OIDC、登录准入 `admit` 求值未装配 |
| AccountCore DO | ~80% | 策略、配置、密封凭据、租约、账号池、出口转发、模型网关（#587）；缺维护执行方、Codex 选号出口、计量调用方；语音不走租约 |
| WorkspaceHost DO | ~45% | 第一版完成（容器经沙盒 provider、空闲休眠、崩溃恢复、化身围栏）；只接了 Pi 引擎 |
| 边缘 Worker＋Client DO | ~10% | 未开始；client-session／edge 模块已就绪（#590），可直接启动 |
| 真实 Cloudflare 演练（`cf:rehearsal`） | 0% | 需要用户提供 CF API Token（经 request_credential） |

## 3. PR 状态

### 已合并（本次会话）
#545 #546 #548 #552 #555 #559 #561 #562 #565 #566 #567 #568 #569 #570 #571 #572 #573 #575 #576 #577 #578 #579 #580 #581

### 在合并队列／CI 中（auto-merge 已开，已订阅）
| PR | 分支（前缀 `claude/fervent-gates-idr8l5-`） | 内容 |
|---|---|---|
| #582 | `lockfile-rest` | 剩余 proper-lockfile 迁到内核锁、Worker 持锁、移除依赖 |
| #583 | `workspace-host-2` | G1 workspace-host 第二部分（已合入 #577 的 `acquireOwnerLock`） |
| #584 | `due-wake-2` | 到期调度第二批（协作泵、编排清扫、自动化、准入、IM、传输） |
| #585 | `account-core-2` | AccountCore 第二部分：账号池、租约兑换、出口 |
| #586 | `relay-workers` | Relay 只打包会启动的 owner Worker；web-server runtime 同级检查 |

| #587 | `account-core-3` | AccountCore 第三部分：模型网关进 AC、个人订阅端口（**`secrets`（gitleaks）仍失败**：拆开 "personal-keys" 与 checksum 同行后在 `71fb7d0` 仍报 1 处；日志脱敏、本会话无法本地运行 gitleaks。下一步：在该分支运行 `gitleaks dir . --config .gitleaks.toml --report-format json` 定位后修正该字面量，不放宽白名单；已在 PR 留言） |
| #589 | `workspace-host-do` | WorkspaceHost DO＋**迁移族收敛**（`@opencraft/sql/families` 唯一原语；Server 扩展族委托且不变；AC 切到 `schema_family_migrations`；删除 `schema-ledgers`） |

| #590 | `client-session-edge` | G1 最后两个模块 client-session 与 edge；**G1 完成**（HA 1064→961 行） |

所有子任务均已结束，没有仍在运行的研发任务。

## 4. 已知问题与必须跟进

1. **迁移族收敛已在 #589 完成**（下述为背景）。**#587 与 #589 必然冲突**：#587 的网关链仍经 `schema-ledgers` 声明（集中在 `modelGatewaySqlSchema()`），后合并的一方需把它改为 `accountPoolSqlSchemas()` 中的一个族。原三套机制：
   - Server 扩展族（main，已发布，表 `schema_extension_migrations`，**不可改**）；
   - `@opencraft/sql/schema-ledgers`（#585，表 `schema_ledgers`，未部署）；
   - `@opencraft/sql/families`（WorkspaceHost DO 分支，表 `schema_family_migrations`，未部署）。
   结果：`@opencraft/sql/families`（组合 `families`／`beside-main`），DO 统一表 `schema_family_migrations`，Node Server 保持 `schema_extension_migrations`。
2. **合并冲突处理惯例**：PR 被 `MERGE_CONFLICT` 出队时，把 `origin/main` merge 进分支（不 rebase／force-push），解决后跑相关测试再推送，重新 `enable_pr_auto_merge`。基于已 squash 合并分支的 PR，用原分支尖端作基准做 `git merge-file` 三方合并（例：#581 尖端 `dedd50c569e78585eb9f3e969c9054afe6155374`）。
3. **CI 已知现象**：
   - `hands-terminal` 的 locale 用例在本容器（只有 C/C.utf8/POSIX）必失败，main 同样失败；CI 上正常。
   - `headless-lifecycle` "slow stop is SIGKILLed" 在高并发负载下接近 20 s 上限，空闲通过。
   - `actor-collaboration-codex` "actual Headless bundle persists…" 在高负载下失败过一次未复现；若 CI 出现请保存完整输出查根因。
   - 推新提交会取消旧提交 CI，汇总检查 `build-checks` 变红属正常（core/gate `cancelled`）。
4. **容器环境**：`npm ci --ignore-scripts` 后需 `npm rebuild node-pty`，否则含终端的测试加载失败。磁盘有限（~10 GB 可用），每个 worktree 依赖约 2.4 GB，用完删 `node_modules`。
5. **已知遗留（#590 记录）**：Web 已创建但未监听时启动回滚，`createWorkbenchWebServer.close` 抛 `ERR_SERVER_NOT_RUNNING`，计入关闭汇总导致数据目录写锁在该进程内不释放；需单独修复。
6. **#584 `gate-tests (platform)` 失败（head `e0d9ad4e4`，run 45356093896，job 138315315724）**：失败发生在合并 #577/#579/#581 之后的提交上；check run 无注释，日志尾部被启动缓存输出淹没，未定位到具体用例。本地对该合并做过 typecheck、headless-composition、collaboration/transport/owner-wake 唤醒测试（56/56）与 check:boundaries，均通过。已于 08:43 `rerun_failed_jobs` 一次（规则允许的唯一一次），**重跑仍失败（08:50），确认为真实失败，不得再重跑**；已在 PR 留言。下一步：下载完整日志查 `✖`/`not ok`，平台 part 含 `test:tasks`、`test:electron-launch` 之外的多个步骤（见 `.github/workflows/build-matrix.yml` 中 `matrix.part == 'platform'`）。
7. **文档**：`gateway-split.md` §5.1 状态表按约定未被各 PR 修改，需要在这批合并后**统一更新一次**。

## 5. 后续主线（按顺序）

1. 把队列中 #582–#590 推到合并（处理 MERGE_CONFLICT 出队与 #587/#589 的迁移族冲突、#584 platform gate）；之后统一更新 gateway-split §5.1。
2. 边缘 Worker＋Client DO：用 client-session／edge 模块＋`@opencraft/http-exchange`、`@opencraft/client-session`，把 IC／AC／WH 三个 DO 串成完整链路（静态资源、路由、Client 会话、模型出口经租约）。
3. 补齐 DO 装配缺口：
   - IC：`openServerInformation`、`openPersonalServices`、`openCapabilityBindings`、`openSpaces`、`openCollaboration`、connectors、MCP apps、push；OIDC 状态入 DO storage；登录准入 `admit` 求值方式。
   - AC：模型网关（进行中）、维护执行方（OAuth 续期在容器内原生 codex）、账号管理路由、出口计量与限额、按记录数据密钥与密钥轮换。
   - WH：执行交付、浏览器、capability MCP、终端、文件、会话资源、Codex／DSH 端点、产品容器镜像、machine id 来源、`credentialLeases()` 接 AC。
4. 真实 Cloudflare 演练：需要用户提供 CF API Token；只能创建／删除 `opencraft-rehearsal-*`／`opencraft-probe-*` 资源；不得触碰用户已有 8 个 Worker（blog、downloader、flue-pi-extension-validation、hermes-worker、royal-hat-f32e、super-math-30bf、withered-union-9202、workers-todo-tight-fire-e399）与 D1；生产部署须先列资源与费用并经用户确认。
5. 其他跟进：Host 侧 token usage 投影改调度；编排清扫被跳过通知的 500 ms 重试；IC 中 `ThreadOrchestrationBroker`／`HumanAuth` 的剩余 Node 依赖；打包产物完整验证（Electron、headless-linux tar、container）。

## 6. 工作约束（沿用）

- 中文沟通；提交信息英文、不含模型名，结尾两行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 与 `Claude-Session: …`；PR 正文结尾 Claude Code 署名与会话链接。
- 分支前缀 `claude/fervent-gates-idr8l5-*`；禁止 force-push、rebase、amend、stash、`reset --hard`；不改主 checkout 当前分支；推送前 fetch＋merge main。
- `gh` 只用于搜索；GitHub 操作走 MCP。
- 主线程不得新增同步 IO（`check:boundaries`）；不改写已发布 SQLite 迁移；新 npm test 脚本须在 `.github/workflows/build-matrix.yml` core-tests 加 step。
- 机密只经 `request_credential`，不进聊天或文件；不提交 sandbox CA。
