# AI 建站持久后端接入交接（国内 / 国际）

> 日期：2026-10-06（北京时间）。性质：停止执行后的本地交接，不是发布完成声明。
> 当前 Goal 已 paused。用户最后要求停止、整理交接；不得依据历史发布授权继续生产、GitOps、TAT 或云资源操作。
> 结论：核心业务接入和通用 Skill 已实现，双区 TEST 主要业务闭环已有通过证据；**尚未达到仅点击发布即可上线的状态**。北京最终 Host 镜像一致性尚未完成，生产区域原生运行基础设施及消费者配置尚未闭合，最终整体源码仍有未提交改动。

## 1. 需求背景与验收定义

原 AI 建站可以生成、发布静态网站。本次要让 Agent 能生成真正服务端 JS 逻辑，并接上平台登录、站点级持久数据，而不是在浏览器 localStorage 或单进程内存保存数据。

用户的关键验收是：在一个浏览器添加业务记录，另一个独立、具有访问权限的浏览器刷新同一网站能读取同一条记录；版本更新、代码回滚、manager 重建、Actor 休眠唤醒及正常 Host 更换不丢数据。国内与国际采用同一能力和隔离合同，分别在北京、韩国共享测试环境验证。

交付范围：

- 基于 **mono2 的 minisandbox 实现** 接入现有 AI 建站，而非 lighthouse/lighthouse-hermes。
- 保持静态建站兼容、平台登录鉴权、站点隔离和有效分享会话。分享访客只读，不因 HTTP GET 而允许数据库写入。
- 隐藏发布：保持原 `show()` 暴露逻辑，服务端能力默认关闭、按批准的 owner allowlist 启用；没有新增前端页面曝光需求。
- Skill 必须通用，不交付固定业务模板。新建机器内置 Skill 与存量机器下发是两条交付链。
- 后续生产验收仅定向国内账号 `usr_143e96b636afd48b3addc752` 的当前真实机器，不全量更新或改其他用户机器。
- 不增加无意义留存测试、不重跑全量测试、不在旧失败对话样例上反复纠缠；必要的最终制品与真实业务检查仍不能省略。

### 1.1 必须纠正的早期判断

早期追踪的 `357477660 / !4891` 是有限无状态能力，不能作为 Skip 已完成持久后端的证据。“建站后端 Skill 完成 80%”“日会进度”等说法没有可核查来源，不能沿用。

本次真实接入源是 `minisandbox/` subtree。可核查 Git 线索包括 Skip 的 `f06c5e0af`（2026-10-02，reviewed source relay）、`e85ba3813`（绑定 reviewed source 与 subtree）、`8ff0c7e69`（subtree ownership）。这些证明源码来源，不单独证明产品接入和生产发布完成。

Skip 提供原生执行及持久化底座；当前工作补上网站产品的打包、发布、鉴权、权限、数据身份、Skill 和区域运维适配。不是仅改一个 URL，也不是重新实现一套独立数据库产品。

## 2. 当前工作区与源码状态

唯一继续工作区：

```text
/Users/shawnmy/.codex/worktrees/website-backend-hidden-release/mono2
branch: codex/website-minisandbox-integration-20261002
HEAD: a3ed8e6ffb6cbcebd072de3dd7bc3bb91ebe505c
```

该 HEAD 包含 request-local handles / actor binding 相关提交，但 **不包含所有最新改动**。本次文档写入前 `git status --short` 显示 Skill、runtime、gateway、workers、native Host、存储续期和部署文档等仍有 modified/untracked 文件。因此不能把 HEAD 当作最终完整源码锁，也不能说整体已 push / merge。

主目录 `/Users/shawnmy/code/mono2` 存在受保护的其他改动；不要在那里重做实现、reset、clean 或覆盖。继续前重新看工作区状态并建立最终 source/artifact lock。

证据根目录：

```text
/Users/shawnmy/.codex/worktrees/website-backend-hidden-release/mono2/.tmp/minisandbox-integration
```

其中可能包含敏感操作材料；**不要复制、打包或提交整个 .tmp**。只交付白名单 safe receipts 和哈希。旧 `current-pre-hidden-release-status.json` 与早期 artifact lock 已落后于最后操作，以后文列出的独立最终回执为准。

## 3. 方案设计：请求、代码与数据走哪里

```text
Agent + 通用 website-builder Skill
  → CTL 建站 API（实例凭据、能力门禁）
  → website-deployer（扫描、拆分静态 / 私有 backend、联合发布）
  → 私有 site-runtime manager（minisandbox driver）
  → 区域 Workers API / Worker Registry
  → Engine / workerd Host / Durable Object
  → SQLite / Depot / FDB；冷存储 COS

浏览器
  → site-gateway
  → 平台 OIDC owner 会话 或 有效分享会话
  → 私有 manager
  → 同一 scope + site 对应的 Durable Object
```

### 3.1 “有后端”和“共享持久化”的区别

仅能执行 `fetch` handler 不意味着有共享持久数据库。当前方案把站点后端放到 workerd 中执行，同时通过站点绑定的 Durable Object 暴露 SQL。浏览器 A 和 B 请求的是同一服务端数据身份，因此可以读取同一份数据；浏览器是否可写仍取决于平台会话权限。

Durable Object 身份由 **scope + site** 稳定生成，不能包含 release ID。代码版本和数据身份分离：更新 / 回滚代码改变执行版本，不应创建一个新数据库。删除数据或按 release 建新对象不属于正常回滚。

manager 本地持久目录用于发布制品、journal 和 receipt；它不是应用原生数据库。Registry 的 FDB metadata + COS immutable code blob、网站静态 COS、数据库冷存储 COS 也是三个不同职责，不能混为一个桶或一条验收。

### 3.2 应用开发契约

- JS 后端能力 `fetch-v1` 与持久数据能力 `rivet-sql-v1` 是独立门禁。
- 源目录约定：`public/` 静态文件，`backend/app.mjs` 单个预打包 ES module。
- ZIP 中私有代码为 `__backend/app.mjs`，不得上传到公开静态 COS。
- handler：`fetch(Request, env, ctx) -> Response`。
- SQL：`await env.RIVET_STORAGE.sql.exec(sql, bindings)`，结果包含 `rows`、`columnNames`、`rowsRead`、`rowsWritten`；另有 `databaseSize()`。
- 数据表的创建和向后兼容由生成的应用代码负责。平台 migration 与应用 SQL schema 不同。
- 不支持任意 Node 进程、宿主文件系统、cron、WebSocket、任意出网、用户 Secret 绑定；公开分享访客不允许写入。

### 3.3 安全与原子发布设计

1. gateway 验证 owner / share 会话后传入受控执行上下文，而非信任浏览器传来的 owner 字段。
2. 分享只读同时约束 SQL：只允许单条 SELECT，不能通过 GET handler 产生数据库写副作用。
3. 用户 handler 串行执行，调用结束撤销 SQL capability；actor bindings 通过 request-local handles 绑定，避免跨请求权限串用。
4. 平台先保护原生对象，再懒加载用户模块；不能让用户初始化代码提前取得原生能力。
5. 前后端联合版本通过部署事务 / CAS 切换，校验真实 package/backend digest 与执行标记。prepare 失败保持旧活动站点。
6. 私有 prepare 校验用于有界探测；旧 DO class 缓存需要安全 abort 才可加载新代码，但必须保留数据库，不能因为一般 503 就 reset 或删对象。
7. manager 经私有 TLS 访问，保留严格 CA/SAN 校验，不使用 skipTLS。

## 4. 具体实现落点

以下路径均相对于第 2 节工作区：

| 路径 | 职责 |
|---|---|
| `ctl/pkg/logic/website/backend_runtime.go` | 建站能力与 backend runtime 接入入口 |
| `workers/internal/website/deployer.go` | ZIP 扫描、静态 / 私有后端拆分、部署编排 |
| `site-runtime/internal/runtime/minisandbox.go` | minisandbox driver、prepare、部署与执行连接 |
| `site-runtime/internal/runtime/minisandbox_worker.mjs` | 用户 JS 包装、SQL 能力与 request-local 权限 |
| `site-runtime/internal/runtime/deployment_transaction.go` | 联合发布事务、版本切换和失败保留 |
| `site-runtime/internal/runtime/service.go` | manager 服务侧执行与生命周期 |
| `site-gateway/internal/httpapi/siteauth.go` | owner 平台认证与策略处理 |
| `site-gateway/internal/httpapi/shareauth.go` | 分享权限、策略刷新与 generation 失效 |
| `site-gateway/internal/httpapi/fullstack.go` | 浏览器到 backend 的代理入口 |
| `minisandbox/infra/cells/internal/workersapi/` | 区域 worker 运行入口 |
| `minisandbox/infra/cells/internal/workerregistry/` | 代码 registry、COS code GET 与动态凭据 |
| `minisandbox/infra/cells/internal/storagesession/` | 有限期存储会话及续期 |
| `minisandbox/infra/cells/cmd/storage-session-renewer/` | 存储凭据自动自然续期进程 |
| `minisandbox/runtimes/workerd/host/src/lib.rs` | 原生 Host 运行 / 生命周期适配 |
| `minisandbox/runtimes/workerd/host/src/sqlite_bridge.rs` | 原生 SQL bridge |
| `.agents/skills/website-builder/SKILL.md` | 通用 Agent 建站指令、能力边界与打包约束 |
| `.agents/skills/website-builder/scripts/package_fullstack.py` | 通用 fullstack 打包工具 |
| `images/helpers/website_skill_bundle.py` | 新机内置 Skill bundle 交付 |
| `.ci/runtime/support/prepare_website_backend_release.py` | 发布绑定、制品与门禁准备 |

详细部署合同先看 `site-runtime/deploy/README.md`、`RELEASE-BINDINGS.md`、`RELEASE-CHECKLIST.md`。任务记录位于 `docs/context/tasks/2026-10-02-website-minisandbox-integration.md`；其旧 frontmatter active 不代表当前 Goal 已恢复。

## 5. 已完成的业务与制品验收

本节是截止暂停的历史执行证据，不是当前在线重新探测。文档阶段仅重新核对本地回执哈希 / 关键状态，不触发业务或云操作。

### 5.1 北京业务已通过，不需要重新跑全套

已有证据覆盖真实 Agent 发布、两个独立浏览器共享持久记录、manager recreate、代码升级与回滚、Actor 休眠唤醒、正常 Host 替换后保留数据、静态切换再返回 fullstack、普通 DNS / 严格 TLS、分享只读与写入拒绝。

北京当前缺的是 **最终源码 native Host 制品更新的一致性收尾**，不是从头重新证明产品能共享数据。最终 native 更新后仅做相称的原记录读取与制品绑定检查。

### 5.2 建站服务最终源码 TEST：双区通过

回执：`full-source-final-test-rollout-20261006/FINAL-safe-receipt.json`

- status：`DUAL_REGION_FULL_SOURCE_SERVICE_TEST_IMAGES_AND_RETAINED_BUSINESS_PASS`
- SHA256：`a8136188f366a7ffeb6677ec5375e4fa39fb19f2efff594fbcf54cd903bdb5f6`

最终服务 image digests：

| 服务 | SHA256 digest（省略 sha256: 前缀） |
|---|---|
| manager | `7d90ddd6d174ffcbc0baed7badcb568ed3d188c7c9eed09d5205c13b9382121d` |
| gateway | `05702147218e457838502368c9378906c31e1104d5a8777cd12eea94ffc27bdf` |
| worker | `f7867cfba6a3fc3b7d95aa383b87e6b71f0b56166998541516499e9acf490a5a` |

### 5.3 韩国最终 native runtime：已闭合

回执：`combined-runtime-kr-final-rollout-20261006/post-rollout-read-preparation/qualification-result.json`

- status：`KR_NORMAL_RUNTIME_ACTUAL_ROLLOUT_ELFS_RETAINED_RECORD_QUALIFIED`
- SHA256：`f807b8761ef12593885f2326dd7c071cdf8162df0051cad45fb98e1c1d81be6d`
- OCI digest：`f2aecba0744b051c9de78e607b7dc5462ace3d1e992c1e0309f56657d6026a5a`
- Engine ELF：`13d1396095f83e91d1097427f5f69308a628c482fdc063ac779239ace2dc21fb`
- Host ELF：`7fb350e9e9b46b7d9bcbc97be91ef497e55d90be21662a712bdbf46892a12c2f`
- workerd ELF：`9b82d8c0895ff173aa0ed1788ab4e6b5d56efef31e4a1e9b7993711d332dab3b`

Pod Ready / imageID / revision 来自 parent receipt；实际 ELF 对五个代表性进程核对，不声称逐副本全部 hash。最终镜像后的原完整记录相等。韩国持久化、分享、升级回滚、生命周期、站点 / Object / Actor / SQL 隔离已有证据，独立分享早期证据保留。

### 5.4 韩国 Go 配套：最后的代码 GET 也通过，不能再报 pending

四个 workload Ready、六个 Pod exact imageID、非 image spec 保留：

`full-source-native-go-readiness-20261006/kr-rollout-successor/rollout-observe-20261006T111842321946Z-safe.json`

启动合同回执：`kr-verification/SOURCE-IMAGE-STARTUP-CONTRACT-safe.json`，SHA256 `c3cf4a48203a36ef0c36b0e7580302a8f86824afd3875aad50574fb77d335aa4`（本节短路径前缀均为 `full-source-native-go-readiness-20261006/`）。

已核查 executable / Entrypoint、受支持的多 binary command override、mount 不覆盖 executable、readonly rootfs、UID/GID 65532、source OCI / registry / actual imageID 一致。两个 controller 没有 readinessProbe，Ready 只证明启动；Registry readyz 可能缓存 30 秒，不能等同于每次 COS 物理 HEAD / GET。无需因为容器没工具而新增逐 Pod PID1 hash 门禁。

自然续期：2026-10-06 19:35:15 CST，新 renewer Pod/Lease 与三类原 Secret UID 绑定、generation/expiry 推进。1800 秒 session、renewBefore 600 秒、poll 30 秒。不是强制续期，也不冒称直接审计到了 STS 调用日志。

- 回执 `kr-verification/natural-renewal-registry-log-safe-receipt.json`
- SHA256 `eb39a70b9e069f7cc651db42aa20cd15171473db48ca933fcb4cc007b7cee3a4`

2026-10-06 19:42:11 CST，一次内部 getVersion 已完成 FDB → COS GET → immutable hash，HTTP 200，绑定最终 Registry 新 Pod 和自然续期后的 code generation。没有输出源代码、响应正文或 secret。

- 回执 `kr-verification/original-code-get-once-safe-receipt.json`
- status `FINAL_SOURCE_REGISTRY_ORIGINAL_IMMUTABLE_CODE_COS_GET_PASS`
- SHA256 `9ec1e8c4dbc016f94ddf07abc321fa2c364948fd4a64a7eb4bda7a391eebbed1`

Go image digests：Registry `11b865927c8794dcf5d39225d1778e1b75a1c40d6af59c877411419664498bfe`；controllers `823bad9c652050cc7704ab8bfed518f1a6ad6816d7a373edfadbf194b3343ff3`；renewer `23a1d69133b0ffe87ee0d110cf9cffec06b7d2b94c6107e7acdeabc54b855734`。

### 5.5 Skill 与新机镜像

- 通用 bundle SHA256：`76bca4098d70f91c1746807c60269d93d15dd6c166f2b00a7bc66e97a8e4b3fe`。
- 北京 TEST candidate：`img-2y50gvk5`；韩国 TEST candidate：`img-gbht69mn`。
- 回执：`new-machine-skill76-20261006/parent-image-acceptance-safe.json`。
- bundle 包含通用 `SKILL.md` 与 `package_fullstack.py`，当前 Skill 无固定业务字样 / 模板。
- bundle helper 的 `LEGACY_FILES` 仍识别旧模板，仅用于历史安装验证 / 回滚兼容，不是新 bundle 内容。
- **未生产采用新机映射，未向目标生产实例下发，未全量更新。TEST image ID 不得直接作为生产 image ID。**

### 5.6 DB migration

2026-10-06 11:42 CST 的只读检查显示上海 / 新加坡生产平台 schema 32 clean，实际五个字段及 defaults 核对通过。证据：`production-website-schema-shprod-20261006.json`、`production-website-schema-sgprod-20261006.json`。

本次没有施加 migration；当前接入不需要新增 CTL migration，不重复施 32、不做 down。应用自身 SQL 建表和升级是另一层；代码回滚要维持应用 schema 向后兼容，不自动回滚用户数据。

## 6. 北京停止点：接手第一优先级

### 6.1 目标和暂停时真实状态

```text
TEST cluster: cls-1femn3mh
namespace: actor-fdb-cell-system
StatefulSet: actor-bj-b01-runtime-hosts
UID: 671c4557-324a-4082-89dd-ac109a542032
实际 replicas: 4（不能按模板改回 3）
bootstrap: ins-8pio5abt
endpoint: https://10.162.0.7
hold: cellb-final-canary-20261006-f525d62fe31f9094
```

本轮经过严格 TLS、已有受保护 kubeconfig、CMS + sealed memfd，没有新签 kubeconfig。server dry-run 成功，实际 hold + OnDelete patch 得到 ACK。随后镜像 CAS 拒绝，**candidate image 未应用，未 drain、未 DELETE，原四个 Host Pod 未更新**。

只读诊断确认四个原 Pod UID / containers / spec / node 未变且 Ready，三个 image slots 仍为旧制品。旧 RV dry-run 拒绝，fresh RV 同一镜像 patch dry-run 成功。

**停止时 STS 仍为 OnDelete + 原 hold，尚未恢复 RollingUpdate / 解除 hold。** 原 Ready Hosts 仍服务，但后续维护必须认识这个遗留状态；不能只看业务正常就把发布标记完成。Engine 不在本次 Host scope，不能说北京所有 native 组件都已最终一致。

### 6.2 失败根因与已准备修正

hold / 策略 patch 后控制器推进 resourceVersion。原 `unchanged()` 在检查其他三个 Pod 之前读取 STS，造成镜像 CAS 使用过期 RV。正确做法是全部 Pod 检查后再 GET STS，然后用 fresh UID/RV 做 image-only CAS。

权威诊断：

- `bj-final-consistency-20261006/normal-native-test-rollout/writer-cas-diagnosis/use-terminal-safe.json`
- invocation `inv-c9iu5ags7d`：SUCCESS，cleanup VERIFIED。
- SHA256 `9bd21fcb0bcc08a35452c812ab32460013d070b90322acb774e4d396d54e3ed8`。
- RV `3586872387` → `3586872410`。
- 诊断结果 `FRESH_IMAGE_ONLY_DRYRUN_PASS_ORIGINAL_NOT_APPLIED`，不是实际更新 PASS。

原执行 `writer-canary-execute/use-terminal-safe.json`：`inv-a9iu10g44s` FAILED，cleanup VERIFIED；hold/OnDelete ACK，candidate-images 未 ACK；native drain 0 / Pod DELETE 0。失败回执保留，不覆盖成成功。

准备好的 continuation：`writer-canary-continuation/guarded.py`（同一 normal-native-test-rollout 前缀），scope SHA256 `3d6c407721ab61ad02a7780a7f111317a3706169285196476d609d43a3b50737`。

### 6.3 未结束的 recipient：不能忽略，也不能盲重试

停止前只提交 recipient：

```text
recipient-one-submit-ledger.json
invocation: inv-c9iu6xgq17
ACKNOWLEDGED
issued: 2026-10-06 19:57:51 CST
run: cellb-canary-continue-20261006-a9847a9127957dbd
```

文档阶段本地再次确认：`writer-canary-continuation/use-one-submit-ledger.json` 不存在，`recipient-terminal-safe.json` 不存在。因此这次 continuation 没有本地已提交 runtime mutation 的证据，也没有 recipient 云任务终态 / key cleanup 已验证的证据。可能仍有 run-owned ephemeral CMS recipient key。

use window 为 30 分钟，约 2026-10-06 20:27:51 CST 到期。后续 **不要盲执行旧 execute-use、重复提交 recipient 或放宽时效、身份 / TLS 门禁**。

恢复授权后的顺序：

1. 先 reconcile `inv-c9iu6xgq17` 的原 recipient invocation 和 ledger；只核对 status / 身份 / cleanup，禁止输出密钥材料。
2. 明确处理本 run 的临时 recipient 清理状态；如窗口已失效，按身份清理并创建全新受审 capsule，不能复用过期授权。
3. 重读目标 UID、4 副本、hold、STS/Pod 状态，确认没有其他人变更；fresh CAS。
4. 仅 canary ordinal 3，按既有 installer / hold / drain 协议正常更新；确认原记录保留。
5. canary 成功后分别推进 ordinal 2 → 1 → 0，不跳过确认。
6. 保留 metrics、PVC、安全字段、commands、620 秒正常 grace；完成后按协议解除 hold / 恢复正常策略并记录 ACK。
7. 如遇身份 / spec 漂移或状态不确定，停在 reconcile，不强删、不清数据、不盲重跑 installer。

本地 adapter 另一个坑：压缩 CMS guest capsule 漏定义 `INSTANCE`，导致解密前 NameError。独立安全诊断证明错误在 initial result，原 remote use-intent 尚未创建；新的 corrected use intent 补齐 INSTANCE 后 dry-run 成功，cleanup VERIFIED。原失败和修正回执都应保留。

## 7. 为什么生产还不能直接发布

已完成的生产检查是 **只读 discovery**，不是已部署：main account `100045199955` 的上海 4 / 新加坡 3 TKE metadata inventory 已收集；检查过的两生产 operations 集群未发现匹配 native workloads / service / RivetCell CRD，消费者 runtime URL 未配置。

这不证明所有账号或所有未检查集群都没有资源。应先确认真正区域目标是否可复用，不能因为两个集群没有就马上建整套资源。

网络前提：上海 operations VPC `vpc-2y7p1lk6`、新加坡 `vpc-253zjh0f` 均在 10.0/12，不能接北京同一 CCN。新只读检查覆盖 SH 7 VPC / SG 3 VPC；源码 Actor aggregate SH 10.176/12、SG 10.224/12 在已观察范围没有碰撞；SH 3 个 AZ、SG 4 个 AZ。仍不代表 VPN/IDC 全局无冲突、机器 quota、TLS、实际部署或连接已合格。

证据：

- `regional-release-discovery-20261006/existing-regional-infra-safe.json`
- `regional-release-discovery-20261006/native-regional-clusters-safe.json`
- `regional-release-discovery-20261006/operations-native-routes-safe.json`
- `regional-production-preparation-readonly-20261006/network-zone-prerequisites-safe.json`
- `takeover-final-freeze-20261006/production-consumer-gates-readonly-safe.json`

### 7.1 两个 endpoint 必须分清

| 配置 | 连接方向 |
|---|---|
| manager 的 `WEBSITE_MINISANDBOX_API_URL` | manager → native Workers API |
| 消费者的 `WEBSITE_RUNTIME_BASE_URL` | CTL / deployer / gateway 等 → 私有 TLS manager |

不能把 consumer 指到 native facade，也不能给 manager 配自己的地址。需要真实区域 hostname、SAN/CA、role refs、WorkersAPI / executor / ObjectRouter / logical datacenter 配套；不能用占位值或照搬北京 ID。

### 7.2 恢复后最短的剩余工作清单

| 优先级 | 工作 | 完成标准 |
|---|---|---|
| P0 | 北京 recipient reconcile 与最终 Host 收尾 | 原 invocation / cleanup 明确，四 Host 正确制品、原数据保留、hold / 策略恢复 |
| P0 | 最终源码冻结 | dirty 变更范围审完，相称门禁通过，commit/MR 与构建 source/artifact lock 对齐 |
| P0 | 确认 SH / SG 原生区域运行目标 | 优先复用；若新建，真实网络 / 存储 / 容量 / quota 输入可执行，而非模板占位 |
| P0 | 区域 native 与存储续期 | Registry / WorkersAPI / executor / ObjectRouter / Engine / Host 合同匹配，三类会话自然续期 |
| P0 | 私有 manager 与消费者配置 | TLS、单 writer persistent store、两类 URL、角色和门禁均有真实值 |
| P1 | 生产镜像晋级和隐藏配置 | 正确 registry digest，默认 closed，只批准 owner allowlist，保留 show |
| P1 | GitOps / Argo 发布验收 | expected revision / image，Synced + Healthy；不能用源码 merge 代替 |
| P1 | 新机 Skill 生产映射 | 区域生产镜像 / blueprint 映射真实生效，非 TEST image ID |
| P1 | 指定生产用户定向 Skill / 实际 Agent | 当前实例定位正确，实际 Agent 工具环境可用，能力 API 200，不只是 TAT ACK |
| P1 | 最终生产业务闭环 | 真实 Agent 生成发布、两独立浏览器共享记录、分享只读；绑定生产版本及原数据回读 |

这些外部变更必须获得重新授权。本交接不授权 apply、push、merge、发布。国际站访问故障用户已自行定位并明确不用再查，不能重新开 `.ai` 网络调查。

## 8. 踩坑与接手注意事项

| 问题 | 已明确的教训 / 处理 |
|---|---|
| 无状态能力被误当作 Skip 完整实现 | 只根据真实 branch/subtree/commit/source 归因；不再引用无来源进度 |
| prepare 503 | 不等于旧站点或数据库丢失；保留旧 release，私有有界探测，不重复业务写请求 |
| DO 旧 class 缓存 | 安全 abort 刷新执行代码，不删除数据；不能把普通错误当 reset 信号 |
| Ready 与能执行混淆 | facade、Host、executor、ObjectRouter、logical datacenter 是不同合同，Ready 不代替真实 code GET / 业务读取 |
| 分享 / owner 策略缓存 | 及时刷新策略，分享 generation 变化应失效，不能仅校验初次登录 |
| gateway 健康但 Agent 工具不可用 | 检查实际 `hermes serve` / Agent terminal 环境；凭据存在性与能力结果分开，永不输出值 |
| TLS projected Secret 是 symlink | regular 0600 要求不能通过投影链接满足；init copy 到 runtime UID 的 emptyDir，保留 TLS 验证 |
| overlay / mirror 与正常源码 build 混淆 | 最终采用 normal producer；旧镜像不能证明最终源码已运行 |
| Go Dockerfile 平台变量 | 两个 Dockerfile 在 FROM 前声明 ARG BUILDPLATFORM，不添加误导 default；r3 正常 build 复用 cache |
| Registry 404 与 JSON 格式 | Harbor 返回 NOT_FOUND 不只是 MANIFEST_UNKNOWN；manifest 一次解析、config 双层 JSON 两次解析 |
| SSH / transport 非零丢 stdout | 不能据此认定没有 mutation；先 reconcile 原 ACK / ledger，不能重 push |
| 新 image field manager 被旧 observer 拒绝 | 修只读 observer 的合法 owner 判定，不重复写 patch |
| controller 多 binary 镜像 | 保留 explicit command，不能用默认 actor-fleet-controller 替代所有进程 |
| renewer Secret RV 正常变化 | pin Secret UID / role，不 pin RV；三类 STS 字段完整更新，root issuer 不进入 runtime |
| 相同 VM 的 machine-id 稳定 | 同一平台 UUID 稳定不是 clone bug；独立性用不同 VM / SSH / 浏览器身份验收 |
| 北京 owner 推断与副本模板 | SSA manager 名不等于持续 Operator owner；无 ownerRefs 也不等于无 reconciler；使用真实 hold/drain 协议、保留 4 副本 |
| 本轮 stale RV | 检查完所有 Pod 后再 GET STS，用 fresh UID/RV CAS，避免旧快照 |
| CMS adapter 漏 INSTANCE | 原失败不可覆盖；新增纠正 intent 先 dry-run，核查 cleanup |
| 旧总状态文件过时 | 以最后独立回执 + 时间 + 哈希为准；不能拿旧 pending 否定后来 PASS，也不能拿旧 PASS 覆盖后来未完成 |

## 9. 回滚、权限与数据保护

- 版本回滚回到已审后端代码 / 静态制品，保持 scope + site 的数据库身份。
- 不删除网站、Durable Object、PVC，不做 migration down，不清 COS 数据，不 pruning 用户制品。
- 发布失败或状态不确定，先查原事务 receipt / journal / invocation，再决定重试；非幂等操作只提交一次。
- 新基础设施如确需创建，使用现有 create-first Terraform 机制并核对真实生产输入；不要复制北京 fleet intent、shared-root、机型或账号 ID。
- 不扩大到其他用户或全量机器；定向实例也要先读取并确认当前绑定。
- secrets、Token Plan key、私钥、CMS 明文、原 kubeconfig、业务正文均不得进入本交接或 Git。
- 在线操作先读 `/Users/shawnmy/.codex/skills/lightclaw-credentials/SKILL.md`，仅调用所需 guarded action，禁止 cat/echo 私有凭据文件。

## 10. 文档交付与下一位执行者的入口

这份文档只整理现状，未恢复 Goal，未提交代码，未 push / merge，未做新云 mutation，未向生产发布。已有业务验收不需要重跑全量；下一位从 **第 6 节北京未完成操作的 reconcile** 开始，然后第 7 节生产前置。

本地白名单证据索引与本文件同目录，文件名 `2026-10-06-ai-website-evidence-index.json`。索引使用仓库相对路径和 SHA256；16 份白名单安全回执已复制到同目录 `2026-10-06-ai-website-evidence/`，不包含凭据或整个 .tmp。原 Mac 路径仅保留作历史定位。文件存在与 hash 匹配只证明本地留存，不能替代后续真实在线检查。

最终“可上线 Ready”的定义是：源码和制品冻结一致、北京剩余状态闭合、双区域真实生产输入与执行底座已备齐、隐藏门禁与 Skill 交付方案可执行、回滚不会清数据。最终“生产完成”的定义还要加 GitOps/Argo 与定向真实业务验收。目前两者都不能宣称全部完成。

## 11. 远端交付补充（2026-10-06）

用户已明确授权提交并推送本次接手代码。交接分支为 `codex/website-minisandbox-integration-20261002`，仓库 `git@git.woa.com:wisp/mono2.git`。此补充覆盖前文“整体最新未提交”和“证据只在本地”的交付状态描述，不改变暂停时的云资源及业务结论。

接手者在自己的机器上执行：

```sh
git clone --branch codex/website-minisandbox-integration-20261002 --single-branch git@git.woa.com:wisp/mono2.git mono2
cd mono2
git rev-parse HEAD
```

已有仓库可 fetch 同名远端分支，再在干净工作区切换或创建独立 worktree；不要覆盖已有本地改动。最终 SHA 以交付者推送后核对的远端结果为准。

交接正文：`docs/handoffs/2026-10-06-ai-website-persistent-backend-handoff.md`。安全证据索引：`docs/handoffs/2026-10-06-ai-website-evidence-index.json`。白名单回执已随分支保存，不需要访问原 Mac。原 .tmp 中的操作脚本、ledger、CMS 等敏感材料不上传；北京 continuation 不可仅凭此分支自动重执行，必须按第 6 节重新 reconcile 并取得外部变更授权。

`config.example.json` / `manifests.example.yaml` 是显式示例，含待替换身份与区域配置，不是生产可直接 apply 的清单。没有把这些占位符当作已完成生产配置。

### 11.1 本次提交前检查范围

- 通过：Skill contract 6 项、Skill delivery 19 项、release bindings 19 项。
- 通过：Node worker / application persistence 40 项（需 `--experimental-vm-modules`）。
- 通过：`GOWORK=off go test ./internal/runtime`（site-runtime）、`./internal/httpapi`（site-gateway）。
- 通过：workers `GOWORK=off go test -timeout 60s ./internal/website`。
- 通过：infra `./internal/workerregistry`、`./internal/runtimecapacity/admission`；storagesession 包编译通过（没有测试文件），storagesession / renewer 的 go vet 通过。
- 环境纠正：默认 Python 缺 PyYAML，release bindings 改用本机 `/usr/bin/python3`；root go.work 未包含 runtime / infra 模块，明确使用 GOWORK=off。初次 Node 未开启 vm modules，重跑后 40/40 通过。这些初次命令不作为通过证据。
- 未执行：全量测试、Rust 重新构建、双区云端重验、生产发布验收。前面的 native build / 运行证据仍是历史回执，不冒充本次重新构建结果。
- 安全检查：变更文件明显凭据模式、白名单回执 signed URL / 私钥 / Authorization 模式扫描，未发现命中；没有把 .tmp、CMS、私有凭据加入 Git。
