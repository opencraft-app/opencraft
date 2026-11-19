# 本地 OpenTelemetry

独立助理现在默认通过官方 OpenTelemetry JavaScript SDK 产生关联日志和 trace，先落本地，不需要 Collector。没有接入 Join、没有网络导出，也不改变记忆、重试、完成或交付规则。

每个 profile 的目录：

```text
<profile>/telemetry/
  logs.otlp.jsonl
  traces.otlp.jsonl
```

每行是官方 `JsonLogsSerializer` / `JsonTraceSerializer` 生成的完整 OTLP JSON Export 请求，不是自创字段模拟 OTel。日志有时间、severity、resource、instrumentation scope；有活动 span 时附 traceId/spanId。可以按 OTLP JSON 协议将一行交给相应 logs/traces 接收接口，但本轮没有添加上传器或 Collector。

运行和评测各自持有独立 tracer/logger providers 和 AsyncLocalStorage context manager，不注册进程全局 provider，不接管现有宿主 OTel。关闭先结束业务和原生资源，再 flush/shutdown。后续增加远程 exporter 应在此装配边界完成。

## 现在记录什么

| Span / 事件             | 含义                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `evaluation.replay`     | 一题历史准备与问答整体，不含关闭 exporter 的时间                     |
| `memory.prepare`        | 一个学习批次/尝试，包括提炼、复核、提交协调                          |
| `context.prepare`       | 一次摘要准备；可能因无需摘要而很快返回                               |
| `reception.process`     | 用户输入或后台报告的接待处理                                         |
| `work.execute`          | 一次后台执行协调                                                     |
| `gen_ai.operation`      | 一次宿主模型请求，含配置的 deadline 和原生资源开销                   |
| `codex.startup`         | 启动原生会话并完成 initialize                                        |
| `codex.version_check`   | 独立二进制版本检查                                                   |
| `codex.rpc`             | 原生 RPC 往返，仅记录方法名，不记录参数或回包                        |
| `codex.turn`            | 结构化推理的 turn/start 至该 turn 完成，包含格式纠正时的独立 attempt |
| `codex.schema_rejected` | 严格解码拒绝一次输出，仅记录角色和次数                               |

每个 span 同时写 `.started` / `.finished` 日志；强杀时可能只有 started。实际抛出的错误以 ERROR 日志和 span status 表示，不保存原始错误正文/堆栈。内部已处理的业务失败不等于函数抛错，例如学习失败写 `memory.prepare.failed` 事件而外层协调可能正常返回；`app.outcome=returned` 只说明调用返回，不能当作 Work 成功。

属性只允许有限元信息：阶段、模型角色、Harness、模型名、attempt、耗时及已知输入/输出 token。未提供的用量不写成零。不记录用户文本、提示词、答案、资料、JSON RPC 内容、环境变量、凭据或原始异常。资源不包含 profile 路径、owner 或用户标签。

借助嵌套 span 可以拆出启动、版本检查、RPC 与生成等待的时间；`codex.turn` 仍包含网络、服务排队和模型生成，不能仅凭它拆出 provider 内部延迟。后台持久委托目前记录执行、启动和 RPC，不宣称具有逐 token 或完整原生内部 span。

## 文件与失败行为

- 目录 0700，文件 0600；拒绝不安全目录/文件和末级符号链接。
- logs/traces 分别以 8 MiB 为上限，保留当前文件和 `.1`、`.2`、`.3`，每 profile 总上限约 64 MiB。轮转会淘汰旧观测，不是永久审计归档。
- 本地导出按记录同步追加，避免强杀前全部停留在内存队列；会增加少量本地 I/O。本轮没有做性能压测，不宣称零开销。
- 导出失败只增加观测错误计数，不能重跑模型或覆盖业务结果。发生部分写入时尽力截回上一完整记录边界；磁盘故障和强杀仍不保证观测完整。
- 本地 `status` 返回 `telemetry` 的 enabled/exported/exportErrors 等状态。关闭后不再接收新日志。

可在停止 runner 后将 profile 配置设为：

```json
{ "telemetry": { "enabled": false } }
```

只接受 enabled 布尔值，默认开启。不从 `OTEL_EXPORTER_OTLP_ENDPOINT` 等环境变量自动开启外发，不加入任何数据库迁移或第二套业务账本。

## 验证与历史成绩

`test/telemetry.test.mjs` 验证官方 OTLP JSON、父子/并发/profile 隔离、日志关联、失败与内容排除、轮转、失败不重试、显式关闭、真实 runner 和评测回放。Codex 原生协议集成还检查启动、版本、RPC、turn 与宿主模型 span 确实落盘。完整业务回归继续验证旧 Pi/Codex 恢复。

日志改动产生新的源码和依赖指纹，既有 67/70 分数仍归旧版本，不因新增 OTel 自动变成新版本成绩。本轮无需发起付费 benchmark。验证记录位于 `evidence/otel-local-20261109/`。
