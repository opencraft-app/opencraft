# Actor identity、Cell 路由与迁移模型

状态：设计约束，路由扩展尚未实现
日期：2026-08-23

本文约束 Rivet Actor ID、Guard peer forwarding 和未来 Actor 迁移。普通 Worker 调用
Durable Object 所需的 Object placement、Cell serving route 与执行面拆分见
`2026-09-22-stateless-workers-durable-object-routing.md`。两类路由不能混为一个状态：前者解析
逻辑 Object 的不可变 home Cell，本文的迁移路由才可能在完成 storage/generation fence 后改变
Actor 的 current Cell。

## 结论

Actor owner 数据面由平行的 Cell 组成。任意 Cell 的 API/Guard 都能接收并转发原生 Actor
请求；集群 C 不拥有 Actor identity、generation、storage writer 或 Cell 内恢复的正确性。

现行产品网络同时把 C 中的 Workers API:6688 定义为区域应用入口。它会承载普通 Worker dispatch
和首版 Object Router，因此 C 的可用性会影响这个公共入口，但不会让已有 Actor 产生第二个 owner
或失去持久状态。以后把 Router cache/proxy 下沉到 Cell 也不改变本文的 Actor 路由不变量。

现有 V1 Actor ID 保持不变：

```text
actor_id = UUID v4 (128 bit) + datacenter_label (16 bit)
```

尾部 label 继续表示不可变的 `home_dc_id`。它不能直接改成 virtual route shard，因为当前
`epoxy_replica_id` 是 `datacenter_label` 的别名，Epoxy 配置和共识协议依赖这一一对应关系。

跨 Cell 迁移通过一张可缓存的路由表扩展现有 ID：

```text
route_key = (home_dc_id, UUID prefix)
route_value = (current_dc_id, route_epoch, state)
```

没有路由记录时直接访问 `home_dc_id`；存在记录时使用最长前缀匹配把一批 Actor 重定向到
`current_dc_id`。单 Actor 迁移使用 exact override。路由切换只改变位置指针，不能代替
generation、存储 writer fence 或 hypervisor I/O capability fence。

## 平面边界

```text
Native Actor API / Actor traffic
             |
      regional data-plane ingress
          /             \
Cell A API/Guard     Cell B API/Guard
          \             /
             Epoxy placement

Cluster C
  |- Workers API / regional Object Router
  |- Fleet UI
  |- OCM / Fleet Controller
  |- Prometheus / Grafana
  |- Cell health and capacity supervision
  `- freeze / drain / retire intent
```

必须保持以下故障不变量：

- C 故障不能破坏 Actor owner、持久状态或 A/B peer forwarding；经 C Workers API 的产品请求会
  暂时不可用，原生 Cell 数据面不因此产生新 owner；
- C 不运行 Engine、Cell NATS、Actor FDB 或 Actor placement transaction；
- C 可以发布带版本和有效期的 admission policy，并可作为可水平扩展的区域 Router；它不能成为
  generation、storage fence 或 Cell 内恢复的权威；
- A/B 具有相同的 API 和 Guard 能力，任何一边都能接收请求；
- Actor 的唯一归属由数据面共识和 generation fence 保证，不由 C 的观测状态保证。

`site-gateway -> C Workers API:6688 -> A/B` 是当前受支持的应用入口。原生 Actor/Guard 仍保持
A/B 平行转发能力；C 的入口不能替代 Cell 内 owner、generation 和 storage fence。

## 当前代码事实

### V1 ID

`rivet_util::Id::new_v1(label)` 生成 128-bit UUID，并把一个 big-endian `u16` label 追加到
UUID 后。`Id::label()` 原样取回这两个字节。API peer 在实际创建 Actor 的 Cell 中调用
`Id::new_v1(ctx.config().dc_label())`，因此最终 ID 的 label 是出生 Cell，而不是最初接收 HTTP
请求的 Cell。

随机 UUID 负责概率意义上的全局唯一性；Cell 之间不需要为无 key 的 Actor 同步发号。无 key
创建每次产生一个不同 Actor，本来就是预期语义。

### `datacenter_label`

`Topology.datacenter_label: u16` 标识当前逻辑 DC，并用于：

- Actor ID 的 label；
- `dc_for_label` 拓扑解析；
- Guard/API 的本地或远端判断；
- peer/proxy URL 选择；
- Actor key reservation 所属 Cell 的表达。

`datacenter_label` 必须全局唯一、不可变且永不复用。Cell 退役后复用旧 label 会把历史 Actor ID
错误地路由到无关 Cell。

当前本地拓扑为：

```text
local-runtime-a: datacenter_label = 1
local-runtime-b: datacenter_label = 2
```

集群 C 不属于 Actor 数据面，没有 Actor `datacenter_label`。

### `epoxy_replica_id`

概念上，`epoxy_replica_id: u64` 是 Epoxy 共识成员身份，参与 proposal、quorum、coordinator 和
replica 消息寻址；它与 Actor 路由身份属于不同抽象层。

当前实现没有独立配置该身份：

```rust
pub fn epoxy_replica_id(&self) -> u64 {
    self.dc_label() as u64
}
```

Epoxy coordinator 也直接把拓扑中的 `datacenter_label` 转成 replica ID。因此当前约束是：

```text
datacenter_label 1 <=> epoxy replica 1
datacenter_label 2 <=> epoxy replica 2
```

这是一种一 Cell 一逻辑 Epoxy replica 的实现约束，不是两个概念天然相同。若未来需要一个 Cell
中多个逻辑 replica、独立 witness，或让共识拓扑与数据面拓扑分离，必须新增独立的
`epoxy.replica_id` 配置并迁移协议，不能只修改字段名称。

### `name + key` 唯一性

业务 key 的唯一性不同于随机 Actor ID。Actor workflow 对：

```text
(namespace_id, actor_name, actor_key)
```

执行 Epoxy Check-And-Set reservation。并发创建只有一个 proposal 能把空值提交为
`reservation_id`；失败方读取已提交值，并根据其中的 label 在本地返回现有 Actor 或转发到所属
Cell。工作流在确认 Epoxy reservation 后才把 Actor 加入可见索引。

因此：

- 随机 ID 不需要全球发号器；
- 同 key placement 必须经过 Epoxy；
- ID label 解决“往哪里发”；
- Epoxy CAS 和 generation fence 解决“只能有一个 owner”。

## 创建与已有 Actor 路由

原版创建请求可以进入任意 Cell：

```text
API request at any Cell
  -> resolve namespace
  -> find enabled runner DCs
  -> honor explicit datacenter or select a candidate
  -> create locally or server-side forward to api-peer
  -> target Cell generates final Actor ID
  -> Epoxy reserves name + key when present
```

当前未显式指定 datacenter 时，`find_dc_for_actor_creation` 取 enabled DC 列表中的第一个值；这
不是容量感知的 Fleet scheduler。未来应由所有 Cell 可消费的、带版本和有效期的 admission
snapshot 提供候选集合，再由 Epoxy CAS 固化唯一 placement。C 可以产生监督证据，但 C 在线不是
创建成功的必要条件。

已有 Actor 使用 ID 快速路由：

```text
actor_id.label() == local dc label
  -> local
otherwise
  -> topology[label].proxy_url / peer_url
```

按 `name + key` 查询时先读取 Epoxy reservation；按全局列表查询时可以 fan-out 到 Cell 后合并。
全局管理 catalog 与请求路由表是两个不同问题，不能让 Actor 热路径依赖 Dashboard catalog。

## 兼容 V1 的批量路由扩展

不能把 V1 尾部 label 直接改成 virtual shard。virtual shard 从 UUID 的稳定前缀派生：

```text
home_dc_id = actor_id.label()
route_shard = prefix(actor_id.uuid())
route_key = (home_dc_id, route_shard)
```

示例：

```text
(home_dc=1, prefix=*/0)       -> Cell A
(home_dc=1, prefix=3a/8)      -> Cell B
(home_dc=1, prefix=3af/12)    -> Cell D
(actor_id=exact)              -> Cell E
```

解析使用最长前缀匹配：

```text
exact Actor override
  > longer UUID prefix
  > shorter UUID prefix
  > home_dc_id default
```

这个模型支持：

- `/0` 移动一个 home Cell 的全部 Actor；
- `/8`、`/12`、`/16` 移动均匀随机的一批 Actor；
- exact override 移动一个特殊 Actor；
- 保持所有 V1 ID 和默认直达路径兼容；
- 用少量路由记录原子切换一批已准备好的 Actor。

概念路由记录为：

```text
ActorRoute {
  home_dc_id: u16,
  prefix_bits: bytes,
  prefix_len: u8,
  current_dc_id: u16,
  route_epoch: u64,
  state: Preparing | Active | Retiring,
}
```

exact override 使用完整 Actor ID 作为 key。实际持久化或 wire schema 必须新增 versioned BARE
版本，并由版本转换器显式映射；不得用未版本化的 `serde_bare` 或修改已经发布的 `*.bare` 版本。

## 热路径与权威状态

路由解析 API 应在实现迁移前先统一：

```text
resolve_actor_location(actor_id) -> (current_dc_id, route_epoch)
```

第一阶段永远返回 `(actor_id.label(), 0)`。加入路由表后：

1. Guard 先查进程内最长前缀路由缓存；
2. 缓存无匹配项时直接使用 `home_dc_id`；
3. home Cell 发现 exact override 时转发并让调用方缓存；
4. home Cell 不可达时才向 Epoxy 查询权威 override；
5. 路由更新通过有序 change stream 分发，各 Guard 以单调 `route_epoch` 拒绝回退。

Epoxy 是路由更新和 CAS 的权威，不在每次请求热路径中。C 可以观察路由 epoch、迁移进度和缓存
滞后，但不能写入绕过共识的 placement 结果。

## 安全迁移

路由记录只解决“请求发到哪里”，不保证单一 Actor owner。跨 Cell 迁移必须使用状态机：

```text
Stable(A, generation=6)
  -> Preparing(A -> B, route_epoch=7)
  -> B restores checkpoint and catches up durable state
  -> fence A generation=6
  -> activate B generation=7
  -> CAS route to Active(B, route_epoch=7)
  -> retire A
```

提交 Active 路由前必须证明：

- 目标 Cell 已恢复完整 checkpoint、私有增量和必要日志；
- 旧 generation 已停止接收新的 ingress；
- 每个 Actor-owned FDB/Depot commit 在同一事务中比较权威 generation；
- runtime host 不能续租旧 generation；
- hypervisor block/network/console broker capability 可以按 generation 拒绝旧 PVM 的副作用；
- 任一步出现模糊结果时保持原 owner 或 fail closed，不能同时激活两边。

路由 pointer flip 很便宜；checkpoint、脏页/日志同步以及 fence 才是迁移的真实成本。PVM warm
checkpoint、COW、共享只读模板和只传私有增量可以降低准备成本，但不能削弱 fencing。

## Quorum 与故障边界

当前 A/B 两个 Active Epoxy replica 对全局 key reservation 和路由变更通常需要 2/2 quorum。发生
A/B 网络分区时必须停止新的 keyed placement 和 route epoch 提升；已有 Actor 仍可按已经缓存的
路由继续服务，但任何需要夺取 owner 的操作必须 fail closed。

Cell 级故障后仍要安全推进 placement，需要至少三个独立数据面故障域形成 2/3 quorum，例如
A/B/D。集群 C 不能因为部署方便而成为 Epoxy witness，否则监督面故障会重新进入数据面安全和
可用性边界。

## 分阶段实现

1. 引入统一的 `resolve_actor_location` 内部接口，保持 V1 行为不变；
2. 为创建候选实现可版本化、可过期、fail-closed 的 admission snapshot；
3. 定义 versioned route schema、Epoxy CAS 和 route epoch；
4. 在 Guard/API 中实现本地最长前缀缓存，默认仍直接使用 ID label；
5. 增加 exact override，并完成受控单 Actor checkpoint 迁移；
6. 增加 UUID prefix 批量迁移和迁移准备索引；
7. 用三数据故障域验证网络分区、旧 writer、旧 PVM I/O、缓存回退和模糊 cutover；
8. 资格验证通过前，不开放自动跨 Cell failover 或自动批量重平衡。

## 明确不做

- 不让 C 代理或串行化所有 Actor 请求；
- 不把每个 Actor 写成 Kubernetes CR 或存入 etcd；
- 不为了 Dashboard list 而让 Actor 热路径查询全局 catalog；
- 不把 `datacenter_label` 静默重新解释为 virtual shard；
- 不在没有 generation/storage/I/O fence 时仅靠修改路由实现“迁移”；
- 不在两副本分区时牺牲唯一 owner 来换取双边写可用性。

## 参考

- Cloudflare, [Supporting Jurisdictional Restrictions for Durable Objects](https://blog.cloudflare.com/supporting-jurisdictional-restrictions-for-durable-objects/)
- Cloudflare, [Control and data plane architectural pattern for Durable Objects](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/)
- Cloudflare, [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
