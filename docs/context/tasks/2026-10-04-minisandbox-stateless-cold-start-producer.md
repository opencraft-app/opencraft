---
id: minisandbox-stateless-cold-start-producer-2026-10-04
type: task
scope: 基于真实WorkerLoader启动与ready边界的固定大小冷启动聚合及原生回归。
triggers: ["stateless冷启动producer", "WorkerLoader真实ready指标", "冷启动与代码缓存区分"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/runtimes/workerd/host/workerd/stateless-worker.js
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进完整stateless/DO/跨Cell/CLS目标中的真实冷启动producer。原生load回调到ready的
fixed histogram不能被Host code-cache miss或JS names数代替。
不把此项当作完整观测完成；不部署或重编workerd/Rust，不改原strict10k或缩短窗口。
不新增自研agent、不调整生产门禁，不把本地microbenchmark当云端容量资格。

## requirement_ids / requirement_refs / requirement_excerpt

正式2026-09-22 stateless/DO routing设计可观测性要求worker_cold_start_seconds、
worker_isolates和DO wake producer；只有真实生命周期才能证明，不能改名cache计数。
用户要求后续探索先行，当前已运行资格不切换；所有工作在/data。

## interface_refs / data_structure_refs / history_context

current_design_refs：routing设计可观测性段；host README动态Worker生命周期。
relevant_evolution：a385c5cc的CLS固定官方collector声明未部署；现有cache-test证明
命名表淘汰后旧stream可保留native Rc，不能当live isolate数量。
superseded_refs：code-cache entries等于live isolates、用户handler错误等于cold-start失败。
锁定fork ce8bdf424dd94e93a39fd1385fdb459336eb76fd：WorkerStub.ready调用channel.whenReady；
WorkerStubImpl等待startupTask并要求default entrypoint。原生map findOrCreate只启动一次。
JSON只有固定bucket和ready/failed结果，无Worker/Object ID或payload。

## acceptance / affected_paths

- actual native callback开始，发起请求ready完成结束，热调用不重计。
- 20并发首次调用只计一次；LRU重新加载重计；syntax/code/default-entry失败单独计。
- 用户handler抛错不是cold-start失败；stats必须auth、GET、no-store。
- 不保留跨请求IoOwn或包装响应流；started-completed不声明live gauge。
- 桶与Engine BUCKETS一致，clock regression夹零且计数。
- Native普通与GC stress gate用既有binary；发布构建增加独立metrics-test。
- 修改root JS/Node/native tests/build gate、host README、正式设计和本Task/catalog。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| root/minisandbox/infra/cells AGENTS全文 | 当前所有权与运行锁 | mono2单源，不编译/部署冻结任务 |
| upstream-subtrees全文 | router must_read | 不修改旧source，bundle锁定fork |
| adjacency/argocd-ci-secrets与runtime manifest/test邻居 | 有界来源定位 | source和release分开 |
| host README、stateless root/native code/tests/config、stateless.rs | 实际producer链 | 不伪造code-cache和namespace标签 |
| workerd lock/setup及锁定fork WorkerLoader/WorkerStubImpl | native真实边界 | ready包含native编译与default检查 |
| runtime build-image.sh全文 | 确定构建门禁的副作用 | 只编辑native test selector，不执行build |
| cloud-environment主文/network全文、observer/TAT helpers全文 | 只读运行状态观察 | selector原样使用，不dump secret，不重启 |
| context-audit主文/assessment/rubric/report全文 | 交接门禁 | wrapper证据不冒充语义评测 |

## evidence / risks / validation / decisions

- 既有native binary version2026-08-07，source ce8bdf...，未编译；完整SHA256留在
  /data/tmp/stateless-native-binary-identity-20261004.sha256，不在Context正文放长hex。
- 新Node11项、native metrics-test/cache-test普通与GC stress均通过；clock/bucket为Node
  纯状态测试，真实single-flight/失败分类/热复用由native gate证明，不靠loader mock。
- inv-a9fv8vgv03 SUCCESS/0，05:57:15Z原supervisor同PID261665和Invocation仍active/running；
  A111Host/115Machine、B4/4、active0，不宣布strict10k或safe shrink通过。
- 临时native benchmark首次绝对embed失败，不当作成功；shell最后tail的exit0不能替代
  native命令状态与PASS selector。改用隔离artifact的相对embed并显式保存命令status后
  再测基线/候选，不重试用户副作用。
- 新ready观察可能增加热路径成本，需实际paired native microbenchmark；其结果仅覆盖
  本机服务绑定，不覆盖HTTP、跨Cell、CPU配额或云上吞吐。
- 首版每次热调用额外ready，六对各5000请求的native微基准总耗时约增加12%；改为只在
  真实cold callback观察，清除callback捕获的pending stub后才await，热路径无额外ready
  或waitUntil。优化后两轮aggregate分别约-0.5%和+6.4%，存在本机波动，不声明零开销或
  生产性能达标；真实HTTP/云性能仍待测。原始日志在/data/tmp/stateless-cold-start-local-
  benchmark-final[-isolated]-20261004.log，fixture目录stateless-cold-start-bench.pNHKjF。
- 临时materialized原生源码与本轮生成的compat link已移到上述fixture目录，保留可恢复，
  不让ignored checkout扩展根instruction scanner的验收分母；没有删除源或修改fork/bundle。
- 06:05:47Z inv-c9fvgvg8ag SUCCESS/0再确认原任务同PID/Invocation仍live，未修改任何云资源。
- runtime contract八项与audit33项通过；root26项仍原四项失败，不将历史Context问题算作
  产品已通过或本轮引入。Context首次检查发现本Task少一个trigger及正文长hash，修复后
  与上轮sorted历史基线比较；不批量重写其他catalog记录或伪称根门禁全绿。
- JSON还是root-only，Host exporter/可信labels/native live/DO wake均未完成；完整目标active。
- 持续运行取消可能不完成记录，不能将未完成计数包装成活跃状态。

## scan_scope / scan_output / handoff / checkpoint

stage：root真实cold-start producer及native语义验证，未发布。
verified：固定大小无ID聚合、cold/hot/compile/user错误分类、现有stream所有权回归。
unverified：Host Prometheus接线、trusted labels、native真实isolate、DO wake与云性能资格。
discard：code-cache或JS names冒充live gauge、日志tail的exit0冒充native test PASS。
restore：mono2 a385c5cc；原strict10k固定PID/Invocation保持。
next_action：检查paired benchmark、交接本地门禁并提交；继续真实exporter与native生命周期实现。
scan限本轮源文件，不输出credential或payload，不触碰云工作负载。
