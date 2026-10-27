# DSH 按需历史恢复

## 行为契约

1. 打开已有会话恢复展示绑定与尾部 Turn 页面，不激活 Agent，不查询会激活 Agent 的 session.models。模型与权限读取来自已保存配置或原生日志的只读描述。读取失败保留会话身份及重试入口。
2. 默认从最新 Turn 开始；翻页只请求更旧的边界，已显示内容和实时状态不回退。Turn/Item 身份沿用 native seq/turn/call identity，不取决于页码。
3. 请求完整 Turn 时允许跨原生消息页补齐它的起点。不得把截断 Turn 标成完整；超大 Turn 的工作量仍与该 Turn 相关，不承诺单个 Turn 恒定成本。
4. Cursor 绑定会话、方向和原生逻辑 seq 边界，进程重启仍可用。跨 native generation 使用既有 routing authority 去除 seed 重复，不能丢弃旧 generation 的历史。
5. AppServer 历史查询不创建、不刷新历史 SQLite 副本。旧 opencraft-history-index.sqlite 保留但不再打开。DSH 原生日志、产品 catalog、routing 和执行回执继续由各自 owner 管理。
6. 历史投影复用稳定 Item 语义；不广播历史 delta，不跳过未经等价性验证的 chunk。只有请求页包含的 Turn 才投影。显式全历史导出/兼容 read 允许遍历，但普通恢复不触发它。
7. 首次执行时懒激活；同 session 并发激活共享 flight，失败后可重试，失败不使已经显示的历史消失。权限修改、注入和 fork 等需要 runtime 的路径同样遵守该边界。
8. 保持现有 AppServer 外部协议和超时；不通过扩大/关闭超时作为性能修复。原生 DSH 冷 inspect 可能读取整个日志，需单独计时，不能称为严格存储分页。
9. Host 通过 `opencraft/resume-history` initialize capability 声明 `legacy/paginated/message-window` 恢复模式，使冷启动深链可直接构造首次 Resume；旧 Host 未声明时才补做 metadata read。`thread/list` 已返回的零 Turn metadata 也可预填 Session View。两者都只是策略提示，不是历史权威，不得携带或展示 catalog 中的 Turns，也不得覆盖已经恢复的 View；`thread/resume` 仍是唯一 authoritative 展示基线。

## 会话绑定与工具声明

- 当前模型不等于最后一次请求模型。显式请求/ThreadCatalog 的持久绑定优先；未绑定的原生会话读取已加载 Agent 的当前选择，再使用历史记录或明确配置的默认模型。没有真实模型时返回空选择，不制造 `dsh` 模型。旧 Catalog 中的 `dsh` 占位值不能阻止重新解析。
- fork 先得到有效选择，再创建并返回同一选择；内部 resume 必须携带刚确认的选择，不能被父历史或空历史覆盖。Catalog 保存响应确认值，不用 nullable 请求字段覆盖它。恢复、fork 和省略 model 的执行都消费同一保存绑定。
- DynamicToolSpec 是协议声明；DshHostCapability 是引擎调用投影。Broker 保留声明快照用于 fork，父子共享声明语义但不共享请求回调。原父连接之外的客户端不能继承其工具所有权。
- 协议形状与引擎 JSON Schema 预检在 native create/fork 前完成。Host 接受声明不等于激活 Agent；冷恢复只绑定 Broker，Engine 可以明确回执 `registered: 0, deferred: true`，该回执不得阻断历史显示，也不得伪装成已可执行。首次执行必须先激活 Agent，再严格完成全部工具的 N/N 挂载，只有成功后 prompt 才能进入 DSH；部分注册或执行前再次 deferred 均失败关闭。释放 Agent 撤销挂载，断开连接撤销 Broker owner。重启不为闲置工具声明唤醒全部会话。

完整迁移与验收记录见 [thread bindings](dsh-thread-bindings/task_plan.md)。

## 验证

- 原生尾页包含十万 chunk 时，一个 AppServer 页不重复刷新同一尾页数千次。
- 最新一页、跨消息页 Turn、空历史、正反分页、非法/跨会话 cursor、generation 拼接及实时身份一致性。
- resume 不调用 native activation；执行共享 activation flight，失败允许重试。
- 新 Host 数据目录没有 opencraft-history-index.sqlite；旧历史索引文件不修改。
- 大规模本地合成历史基准、真实安装版原生只读数据源及隔离客户端验证分别报告。


## Bounded reconnect contract

DSH advertises full initial-page and bounded-recovery support. Its adapter owns a
history epoch independent of client/socket reconnection. Restarting the adapter
or declaring the native engine unavailable invalidates old checkpoints. Logical sequences come
from `DshRoutedClient`/routing, preserving generation seed deduplication; they are
not synthesized from client connection generations.

Without a trusted checkpoint Resume reads the latest five complete Turns. With a
checkpoint but no verified matching head, it probes one forward range ending at `nextSeq + 256` using the native
`beforeSeq` contract. If this range reaches the current head and covers the cursor,
only changed Turns are projected; equal head returns no transcript. A full range,
missing coverage or rewind immediately falls back to latest tail. It never loops
through the entire offline gap. Native pages are message/Turn aligned and can
contain many events or a large Turn; 256 is a sequence probe bound, **not** a strict
byte/CPU bound. All old content remains accessible by explicit older pagination.

An owned native `thread.describe` also returns its exact native history head from
the same live/inspected log used for model and permissions. The Host captures the
routing generation before awaiting describe, rejects a changed route, validates
native identity and safe sequence coordinates, and translates the seed offset.
Only a matching adapter epoch and logical head can acknowledge unchanged history
without a history RPC. Missing/invalid metadata (including an older plugin),
changed history, rewind and foreign checkpoints retain the probe/tail path.
An engine restart during Resume rejects the obsolete result. A persisted list
projection watermark is never a substitute for the current native head.

History projection uses the generation already captured for that page; it does
not query the generation row for each event or cache routes across requests.
Views, attachments, seed filtering and source/surface coordinates are preserved.
While Resume is in flight, the requesting logical Client receives observations
for that Thread so Session can merge events arriving after the baseline cut.
This temporary delivery scope grants no attachment, execution or interaction
ownership on failure and stops immediately when the Client is revoked.
Do not claim this removes large-single-Turn cost or bounds native storage scans.

Regression entry `tests/execution/recovery-dsh-chain.test.mjs` exercises real Workbench,
Session and Adapter over MemoryTransport, with synthetic native history only:
merged first page, older-only navigation, same-generation revalidation, unchanged,
small append and one-forward-probe→tail gap. It performs no model execution.
