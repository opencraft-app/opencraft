---
id: minisandbox-stateless-isolate-cache-2026-10-04
type: task
scope: 为 stateless WorkerLoader 命名缓存加入有界 TTL/LRU，验证淘汰不打断在途流。
triggers: ["stateless isolate cache", "WorkerLoader eviction", "named isolate LRU"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/runtimes/workerd/host/workerd/stateless-worker.js
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal

历史访问大量 Worker/Version 不得使 stateless WorkerLoader 的命名引用表无限增长；
缓存淘汰不改变原始 URL、HTTP body/stream、在途请求或 Durable Object 所有权。

## non_goals

- 不修改正在运行的 strict10k、镜像、副本、负载或普通重试门禁。
- 不把命名缓存条目当真实 live isolate/RSS 指标；原三个生命周期指标要求仍保留。
- 不修改 workerd fork、FDB schema、Actor generation 或持久化内容。
- 不声称本地测试已经构成云上发布或容量资格。

## requirement_ids / requirement_refs / requirement_excerpt

- 原设计“isolate 只作为可复用缓存，不是用户可寻址资源”。
- 原设计“缓存与规模”和 Phase5 的海量代码、流式与取消门禁。
- 用户要求性能劣化应从单位成本/所有权建模修正，不只增长物理副本。

## interface_refs / data_structure_refs

- `WORKER_LOADER.get(name, callback)`；命名缓存由原生 WorkerLoader namespace 持有。
- `WORKER_LOADER.unload(name)` 只删命名引用；当前 fork 的 SubrequestChannel 持有独立 Rc。
- root JS 只能持有有界 name/last-use 表，不跨请求缓存 WorkerStub/IoOwn。
- 两个受信配置 binding 控制 capacity/idle TTL，不从用户 headers 或用户 env 读取。
- eviction 允许后续请求重新创建 stateless isolate；不承诺全局变量持久性或单实例。

## history_context

- `current_design_refs`：stateless-workers-durable-object-routing 的缓存与规模、指标合同。
- `relevant_evolution`：32af2709 的 Host 代码缓存有界，但 root JS 未调用 unload。
- locked fork ce8bdf424dd94e93a39fd1385fdb459336eb76fd/tree bb0dcb64842239dcade1f1b42b60b26e42e55b25
  中 `Server::WorkerLoaderNamespace` 使用无上限 HashMap，只有显式 unload/abort 删除。
- `superseded_refs`：不得从 Host code-cache entries 推导 live isolate 数量。

## acceptance

- 真实 root JS 的 unit tests：容量/LRU/TTL、loader 分区、畸形配置拒绝、unauth/无效请求不触碰缓存。
- 真实已存在 workerd binary：淘汰后重新加载、热复用、在途响应流完整、不修改 body/URL。
- 生产 manifest 的两个配置 binding 渲染/范围校验与相邻静态合同通过。
- scoped format/type syntax、文档/context/change-impact 门禁；原 baseline 失败分开报告。

## affected_paths

- minisandbox/runtimes/workerd/host/workerd/
- minisandbox/runtimes/workerd/host/README.md
- minisandbox/infra/cells/deploy/tencent/fleet/runtime/stateless-executor.yaml
- minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_stateless_executor_contract.py
- minisandbox/infra/cells/deploy/tencent/fleet/runtime/build-image.sh
- minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md

## required_context

- upstream-subtrees、agent-gateway-runtime、release-gitops、service-sandbox、control-plane-ops。
- AGENTS.md、minisandbox/AGENTS.md、minisandbox/infra/cells/AGENTS.md。

## context_receipt

| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `docs/context/project/upstream-subtrees.md`、`docs/context/domains/{agent-gateway-runtime,release-gitops}.md`、`docs/context/project/services/{ctl,sandbox}.md` | 路由 must-read 与发布边界 | mono2 唯一写源，非相邻服务变更，不将本地测试冒充发布 |
| `AGENTS.md`、`minisandbox/AGENTS.md`、`minisandbox/infra/cells/AGENTS.md` | 源码、测试、资格边界 | 新 jj sqpsrvzt、独立 Task，不扰动唯一云端 producer |
| `runtimes/workerd/{workerd-fdb.lock,setup-fork.sh,host/{README.md,src/{stateless,lib}.rs,workerd/{stateless-worker.js,config-stateless.capnp,worker-loader-abi-test.js,worker-loader-abi-test.wd-test}}}` | 真实加载、IoOwn 与卸载契约 | 已有 fork 的 get/unload，不引入新 C++ API |
| `infra/cells/deploy/tencent/fleet/runtime/{stateless-executor.yaml,install-stateless-executor.sh,test_stateless_executor_contract.py,build-image.sh}` | 运行配置和产物邻接 | JS 是镜像内独立 staged 文件，未变 V8 不重编译 |
| `docs/context/project/adjacency/argocd-ci-secrets.md`、`infra/cells/deploy/tencent/fleet/{README.md,gitops/README.md}` | 受信配置和发布邻接 | Secret仅按引用使用，master源码不等于Argo发布 |

## evidence

- `/data/minisandbox/third-party/workerd-fdb` 只读复核 HEAD/tree 与 lock 一致且 clean；
  `git show ce8bdf...:src/workerd/server/server.c++` 的命名表/删除/在途 Rc 为源码证据。
- 本地已存在 workerd 2026-08-07 static PIE，SHA256前缀 `f5cfb330238ca6f2`，
  完整值已由sha256sum原生命令记录；没有重新编译。
  native 和 GC stress 对实际 production root JS 都 PASS；不当作 production release provenance。
- 原云上 run7d5fa6ac 在20:36:41Z仍为同一 InvID/PID，4133 ready、424175交互零失败，
  普通重试和身份漂移0。A119/B116 desired Machines，Ready113/116；Host Ready105/108。
  仍warmup，没有postwarm 3秒样本，也没有strict10k终态收据。
- 随后20:47:11Z inv-e9fd570ai2观察到普通retry1，负载已按严格规则停止新增；
  inv-c9fd6f0i1p SUCCESS/0读取真实journal：20:47:07.847Z/index360/active/503
  upstream_unavailable。load receipt于20:47:09.117Z明确failed，5394 ready/5381proven、
  721990交互最终成功，不能以重试后的成功抵消资格失败。state已load_exit_status=1，
  supervisor按原图继续精确清理与自然缩容。候选JS未发布，不是这次重试的运行代码。

## risks

- workerd unload 后物理 isolate 可被在途 Rc 暂时保留，named cache bound 不等于硬 RSS 配额。
- 相同版本在淘汰期间可同时有旧在途实例/新实例；这是 stateless 语义，不用于 DO。
- TTL 使用按请求懒清理，没有无人请求时的后台 timer；总条目数仍始终受容量约束。
- 失败配置不能退回无限缓存，root boot/request 必须 fail closed。

## validation

- Node9/manifest8/native GC-stress PASS；14 stage-reuse回归PASS，没有V8或Rust新构建。
- 四个JS scoped Biome格式复查与node syntax PASS，build-image bash syntax PASS。
- 文档0errors/0warnings；全部13条真实jj变更路径的change-impact与diff-check通过。
- Context仍4970历史错误，排序JSON错误集合SHA256前缀3683219cb7fa58c7，与旧基线一致；
  新Task无错误。Context26测试仍同4失败：治理资产、中文比例、服务预算、全仓validator。
- context-audit33测试PASS；discovery已落/data/tmp但仅needs_agent_review/not_assessed，
  不把扫描完成冒充人工评估资格。13文件敏感模式扫描无发现。
- 明确日志：`/data/tmp/minisandbox-stateless-isolate-cache-final-{unit,contract,native}-20261004.log`、
  `stage-reuse-20261004.log`、`context-tests-20261004.log`、`audit-tests-20261004.log`
  均使用同一minisandbox-stateless-isolate-cache前缀；文档/context2结果另为JSON。

## decisions

- 不保存跨请求 WorkerStub，只跟踪命名缓存身份；由既有原生 Rc 保留在途对象。
- 不包装响应 body 做 pin，不引入新的 stream framing/cancellation 路径。
- 上线须等待原压测结束并走正式 image/release；本轮只落地源码和本地验证。

## scan_scope

- 限定 root JS、Host source、stateless manifest 与 lock 指定的 WorkerLoader/server 源码。

## scan_output

- 猜测的 runtimes README/build.rs、runtime entrypoint.sh 和 runtimes/third-party 路径不存在，
  按 setup-fork 与目录 inventory 转到真实 host/README、stateless init 和 minisandbox/third-party。
  只读现存 fork，不复制或修改旧 checkout。
- guessed `.agents/context/catalog.{yaml,json}` 与 adjacency/upstream-subtrees.md 不存在；
  回到 validator 的精确实现与 adjacency inventory，使用真实 docs/context/.context/catalog.jsonl
  和 argocd-ci-secrets 邻接卡，检查 stateless manifest/test/build-image/正式 Hook README。
- native 首次被多余 nodejs_compat 默认 flag 拒绝；移除后真实测试发现新代码把 tee 放到
  forwarded Request 构造之后，造成 used body 500。修正为 original URL 验证后、构造前 tee，
  native 与 GC stress 重新PASS。早先 tail 掩盖 shell status 的输出不算通过。
- provided agent-format 两次被 `/data` 下嵌套 root 配置拒绝；不迁移或修改其他项目配置。
  已对四个本次 JS 文件使用同版本 Biome 2.3.11 的显式独立配置/标准输入完成格式化，
  只机械写回这些文件。猜测 root package.json 不存在，不安装或改依赖。
- background故障检索最初误猜local/mesh Agent harness及actor_cache.go路径，均失败；
  按run-on-builder与workersapi inventory定位真实load/shared-agent-scale/runner.mjs、
  object_router.go、upstream.go，不从错误搜索推导诊断结论。

## handoff

- sqpsrvzt 已实现 root-cache 与独立 native/unit 回归；9 Node/8 manifest tests PASS。
- 正式build-image已接入同一native GC-stress测试，对精确staged binary和production root执行；
  不依赖测试替身，也不要求新增V8 API或重新编译fork。
- 默认16引用/60秒，native容量256上限；命名引用与真实live isolate/RSS必须分别计量。
- 未发布候选，不扰动2757 supervisor。聚焦格式/治理门禁已完成，待推master。
- 原负载严格failed，下一项独立保存真实收据、定位一次普通503，验证清理/自然缩容；
  不提高retry额度、不重复producer、不提前绕过共享锁发布候选。
- 原strict10k producer继续；20:31提交比上次五分钟约定早17秒，下一次以真实native终态
  加五分钟为边界，不把提前观察当作额外容量证明。

## checkpoint

- scope：有界stateless命名缓存，本地开发，无新runtime build、云上rollout、force delete或长soak。
- 已消除POST body tee排序错误；实际native与GC stress测试通过，未包装在途响应。
- 文档门禁0errors/0warnings；Task自己的catalog记录需与最终内容hash同步，历史治理baseline不变。
- 唯一supervisor仍为7d5fa6ac/c5d5db1b/PID261665；20:47:11Z的运行观察、20:48:31Z
  的只读failure diagnostic均SUCCESS/0，但真实load receipt verdict=failed。
  下次运行/缩容进度观察不早于20:52:11Z；故障证据调查可独立进行，不变更负载图。
