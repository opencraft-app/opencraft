# Computer 删除后自动重新纳管设计

## 背景

Vela Computer 以当前 macOS 用户的 `~/.vela` 作为安装根目录。首次安装完成后，本地
install journal 进入 `complete`。再次执行安装命令时，安装器会在访问后台前返回：

```text
Vela Computer is already installed for this macOS user.
```

这个保护能避免正常 Computer 被另一条安装命令覆盖，但没有覆盖一个合法生命周期：用户在
Web 删除旧 Computer A 后，创建新 Computer B，并在同一台 Mac 上执行 B 的安装命令。

后台删除 A 时已经：

- 拒绝删除仍绑定有效 Agent 的 Computer；
- 将 A 的 `lifecycle_state` 写为 `removed`；
- 将 A 的当前 Computer credential 写为 `revoked`；
- 删除未消费的 setup code 并清除 enrollment 材料；
- 保留真实机器和腾讯云 TAT 外部纳管实例。

本地仍保存 A 的完整身份和 TAT 状态，因此安装器无法判断它是正常安装还是已经被后台删除。

Raft Computer 1.0.13 的可观察行为提供了三个有价值的设计输入：只读 preflight、严格区分
`computer_machine_unlinked` 与普通鉴权失败，以及持久化 terminal marker 后停止无意义重试。
Vela 只采用这些行为事实，不复制其实现文本或控制流。

## 固定产品决策

- 删除旧 Computer 后，执行新 Computer 的安装命令自动完成换绑，不要求 `--replace`。
- 正常 active Computer 永远不能被自动覆盖。
- 自动换绑只支持同一 Platform origin、同一 Server、同一 macOS 用户。
- 旧 Computer 行保持 `removed`，不复活、不复用 ID。
- 删除 A 时必须立即解除 Vela 对 TAT 实例的当前占用：binding 从 `active` 进入
  `retired`，A 清除当前 TAT 引用。`retired` 只是一条防重与审计墓碑，不代表仍被纳管。
- 腾讯 TAT 外部实例及本机私钥可以继续存在；安装 B 时重新认领同一个已退役实例，不创建第二个
  TAT identity，也不把已删除 A 视为 binding owner。
- `~/.vela/workspaces` 永远不参与换绑。

## 目标

- 只有持有正确旧 credential，且后台确认旧 Computer 已 `removed` 时才自动换绑。
- credential 轮换、自然过期、单独撤销、网络失败和身份损坏都不能授权换绑。
- 沿用现有 `Authorization: ComputerCredential <crc_...>`，不引入第二套长期身份。
- 后台使用现有 TDSQL 分布式事务，在 `server_id` 分片完成 enrollment claim，并在
  `binding_hash` 分片重新认领 retired TAT identity。
- Agent 保留现有 `state/tat` 和唯一 TAT runtime，仅原子切换平台 identity generation。
- 远端请求成功但响应丢失、进程崩溃或机器重启后可以恢复同一换绑事务。
- credential、setup token 和 replacement grant 不进入日志、URL、trace 或测试夹具。

## 非目标

- 不支持跨 Server 自动重新认领 TAT identity。
- 不把 active Computer 的旧 credential 自动修复为新 credential。
- 自动重新纳管不承担二进制升级；B 的 release/target/program hash 必须与当前已安装版本一致。
- 不远程卸载真实机器，不删除工作区。
- 不新增数据库表，不改变现有 `server_id` 与 `binding_hash` 分片键。
- 不通过腾讯云 TAT Tag 推断平台身份；Tag 仅用于诊断，不是授权或路由真相源。

## 终态分类

后台只把 `Computer.lifecycle_state = removed` 视为允许换绑的不可逆终态。

| 状态 | 条件 | Agent 行为 |
| --- | --- | --- |
| `active` | secret 匹配、credential current、Computer active | 保留现状，返回 already-installed |
| `removed` | secret 匹配、Computer removed | 写 terminal marker，允许自动换绑 |
| `not_current` | secret 匹配，但 active Computer 的 credential 已轮换、过期或单独 revoked | 不换绑，进入 credential 恢复/人工处理 |
| `invalid` | 路由不存在、secret 不匹配或结构错误 | 不换绑 |
| `unavailable` | 网络、TLS、5xx、超时或响应畸形 | 不换绑 |

`revoked` credential 本身不是 Computer 已删除的证据。daemon 也不得根据普通 401、长时间离线、
本地文件年龄或 TAT 状态推断 `removed`。

## 后台设计

### 路由专用 credential 检查

普通 `ComputerCredentialAuth` 业务端点保持现有 current-only 行为，避免扩大协议与状态探针表面。
preflight 路由复用相同的 `ComputerCredential` header 解析、完整路由格式和 secret digest 算法，
但使用一个只供该路由调用的 inspection policy。

inspection Repository 以 credential 内完整的：

```text
server_id + computer_id + version
```

读取 credential 与 Computer。所有 Ent 查询都显式携带 `server_id`，禁止通过 relation 产生跨分片
查询。返回值包含 secret digest、credential state/expiry 与 Computer lifecycle/revision。普通探测
不读取 TAT registry。

检查顺序：

1. 严格解析 `crc_` 路由和 32 字节 secret；
2. 按 `server_id` 路由到单分片并查询完整键；
3. 查无记录时使用进程启动时生成的固定 dummy digest，继续执行同样的恒定时间摘要比较；
4. 摘要不匹配或路由不存在统一返回 `computer_credential_invalid`；
5. 摘要匹配后再读取 credential 与 Computer 状态并分类；
6. 只有 Computer `removed` 返回 terminal 结果；
7. active Computer 的非 current/expired/revoked credential 返回
   `computer_credential_not_current`，绝不返回 removed。

数据库命中与未命中本身可能存在统计时序差异，因此规格不声称完全隐藏路由存在性。端点必须有
独立速率限制、统一响应大小，并以统计时序测试防止明显分叉。知道路由但不持有 secret 的调用方
始终只能获得 `computer_credential_invalid`。

### Removed 证明保留

v1 中 `removed` Computer 墓碑不物理删除。完成删除时的最后一份 credential digest 永久保留，
仅保存 route、digest、state 与时间，不保留明文。credential 清理任务不得删除 removed Computer
的最后一份证明记录。这样合法旧机器不会因 30 天清理窗口退化为永久 ambiguous。

### 只读 preflight

OpenAPI 新增：

```http
POST /v1/computer/preflight
Authorization: ComputerCredential <old crc credential>
Cache-Control: no-store
Pragma: no-cache
```

普通探测发送空 JSON 对象。安装器请求重新认领时可附带：

```json
{
  "replacement": {
    "enrollmentToken": "<B enrollment token>",
    "tatRegion": "ap-beijing",
    "tatInstanceId": "rins-..."
  }
}
```

`tatRegion/tatInstanceId` 来自本机 TAT 状态的只读检查接口；不得由 UI 或安装命令参数覆盖。
`enrollmentToken` 是敏感字段，必须加入反向代理、HTTP middleware、trace 和错误日志的结构化脱敏规则。

响应：

- `204 No Content`：Computer active 且 credential current；
- `410 application/json`，code=`computer_removed`：secret 匹配且 Computer removed；
- `410 application/json`，code=`computer_provider_identity_gone`：replacement identity 已明确销毁；
- `409 application/json`，code=`computer_replacement_identity_mismatch`：replacement identity 不属于 A；
- `409 application/json`，code=`computer_credential_not_current`：Computer active，但 credential
  不是 current；
- `401 application/json`，code=`computer_credential_invalid`：路由或 secret 无法证明；
- `429/5xx`：统一标准错误。

错误响应必须使用现有 `Error` schema，固定 `application/json`，并带 `no-store/no-cache`。
preflight 不签发 Session、不更新 last-seen、不写业务表，也不返回 Server、Computer、租户或用户信息。

### Replacement grant

当且仅当以下条件同时满足时，`410 computer_removed` 响应额外返回短期
`replacementGrant`：

- A 的旧 credential secret 摘要匹配；
- A 为 removed，且请求给出的 `binding_hash(region, instanceId)` 命中一条 `retired` 墓碑；
- 该墓碑的原 `server_id/computer_id` 精确指向 A，不存在任何 active owner；
- enrollment token 指向同一 `server_id` 下、处于 provisioning 且未 claim 的 B；
- B 的 generation、release version、target、program SHA-256 与 enrollment token 完全匹配。

grant 使用现有后台签名基础设施，但具有独立 audience `computer-replacement`、5 分钟 TTL，并绑定：

- old/new server ID 和 Computer ID；
- old lifecycle revision、credential version、binding hash、TAT region 与 instance ID；
- new enrollment generation、token hash、release version、target 与 program SHA-256。

grant 是短期一次用途 capability，不是新的登录身份。签发 grant 不写数据库。安装器将 grant、
enrollment token 与客户端 secret 分别原子写入三个 `0600` 文件；journal 只保存文件名和 SHA-256。
三者同属事务临时秘密，完成或放弃时必须删除并同步父目录。

### 解除纳管事务

删除 Computer 是 binding 生命周期的同步终点。TDSQL 使用跨 `server_id + binding_hash` 分片事务；
SQLite 使用一个本地 ACID 事务。两者采用相同锁序和提交不变量：

1. 在 `server_id` 分片锁定 A，重验无有效 Agent 绑定；
2. 若 A 有当前 TAT identity，按 `region + 0x00 + instanceId` 计算 `binding_hash`；
3. 在 `binding_hash` 分片锁定 registry 行，并验证其为 `active` 且 owner 精确为 A；
4. 将 registry 行置为 `retired`，保留原 `server_id/computer_id` 作为墓碑来源；
5. 将 A 置为 `removed/offline`，清除 `tat_instance_id` 与其他当前 binding 字段；
6. 撤销运行凭证、删除 setup code并提交。

任一步失败则整体回滚，Web 删除返回失败；不得出现 A 已 removed 而 registry 仍 active，或 registry
已 retired 而 A 仍 active 的中间成功状态。重复删除对完整 removed/retired 结果幂等；若两边不一致，
返回一致性错误交由修复任务处理，不能将异常状态解释为可重装。

腾讯 TAT 外部实例不因本事务被销毁或注销。它仍可能与腾讯侧保持 WebSocket，但 Vela 后台没有
active registry owner，因此不能通过任何 Computer 业务路径向它下发命令。

`retired` registry 墓碑不得被普通保留期任务删除。它一直保留到以下二者之一：

- 被合法重新认领，同一行回到 `active` 并更新 owner；
- 管理员显式确认腾讯侧外部实例已经销毁，后台再次核验不存在后将同一行置为 `purged`。

`purged` 仍是永久、无秘密的防重墓碑，不物理删除，因此相同 binding hash 永远不会被误认为从未
存在。腾讯侧实例暂时离线不是销毁证据。带 replacement body 的 preflight 命中 `purged` 时返回
`410` + `computer_provider_identity_gone`；命中不到 A 的 retired/purged 墓碑时返回
`409` + `computer_replacement_identity_mismatch`。两者都不签发 grant、不改本地状态，也不自动用
新注册码覆盖旧 TAT 私钥。空 body preflight 仍只按 Computer lifecycle 返回 `computer_removed`。

### Claim 与 TAT identity 原子重新认领

现有 `/computer/enrollments:claim` 请求增加可选 `replacementGrant`。没有该字段时保持首次安装语义。

有 replacement grant 时，TDSQL 在 `server_id + binding_hash` 两个分片执行现有 2PC；SQLite 在一个
本地 ACID 事务中执行相同锁序与状态检查：

1. 验证 grant 签名、audience、有效期与 enrollment token hash；
2. 在 Server 分片锁定 A、B、A 的证明 credential 和 B 当前 enrollment；
3. 在 registry 分片锁定 grant 指向的 binding 行；
4. 重验 A 仍 removed 且无 current TAT 引用、revision 未变化；
5. 重验 binding 仍为 `retired`，墓碑来源为 A，region/instance/hash 与 grant 一致；
6. 重验 B 仍 provisioning、未 claim，且 generation/token/release version/target/program SHA-256
   全部一致；
7. 使用现有 credential digest 规则 claim B；
8. 将同一 registry 行更新为 `active`，owner 改为 B；
9. 将 B 的 `tat_region/tat_instance_id/kind` 写为重新认领的 identity，并置为 active；
10. 保留 A 的 removed 墓碑、空 current TAT 引用与 credential 证明；
11. 2PC 提交后返回 B 的 credential route/version 和 `providerBinding=reclaimed`。

事务禁止跨 Server。TAT instance ID 是 backend 定位腾讯云实例的真相源；旧 Tag 可以由现有
Tencent operation 异步刷新，但 Tag 更新失败不影响授权、命令路由或换绑正确性。

### 幂等规则

B enrollment token、generation 与客户端生成 credential digest 继续构成现有幂等 claim 身份。

- 首次事务成功：创建 B credential 并重新认领 retired identity；
- 成功响应丢失后重放：如果 B 已以相同 digest claim 且 registry active owner 为 B，返回同一
  route/version；不再次修改 registry；
- 相同 token、不同 digest：冲突；
- grant 过期但事务已经成功：现有 claim 恢复分支仍可返回相同 B credential；
- grant 过期且事务从未成功：要求重新 preflight 取得新 grant；
- retired identity 已被其他事务认领、A revision 改变或 B 已被其他 digest claim：冲突，不猜测恢复。

安装器必须保存完整 replacement grant，直到取得 claim 响应并确认 B healthy。重放时服务端先验证
grant 签名和全部绑定字段；如果 grant 已过期，只允许进入“事务已经提交”的只读恢复分支：B 已用
相同 enrollment generation、token hash 与 credential digest claim，且 registry active owner 精确为 B。
该分支只返回原 route/version，不产生任何写入。grant 缺失、签名错误或提交证据不完整时不能恢复。

SQLite 的进程崩溃由本地事务原子性收敛为提交前或提交后；TDSQL 的超时/连接中断按 transaction ID
查询最终提交结果。两种数据库都不得在不确定提交后重新执行状态变更，只能先判定上述完整不变量。

数据库继续使用 `server_id + computer_id + version` credential 唯一性与
`tat_instance_bindings.binding_hash` 全局唯一性；不新增全局索引。解除纳管和重新认领都必须走既有
跨分片事务门禁，不能退化成两个独立本地事务。

## Agent 设计

### 本机 TAT identity 只读检查

内嵌 Rust TAT library 增加一个只读 C ABI，向 Go 返回当前 `region + instanceId`。它从已初始化的
`state/tat/config.dat` 读取，不发起注册、不启动第二个 runtime，也绝不返回 register code、machine ID、
private key 或签名材料。Go 只在已存在完整 TAT identity 时进入重新认领流程；状态缺失或畸形时
fail closed，不用新安装码覆盖原状态。

### Identity generation 与 TAT state 分离

端侧状态调整为：

```text
~/.vela/
├── install.lock
├── replacement.journal.json
├── replacement.enrollment
├── replacement.secret
├── replacement.grant
├── state/
│   ├── tat/
│   ├── identities/<transactionId>/
│   │   ├── config.json
│   │   ├── computer.credential
│   │   ├── computer.credential.meta.json
│   │   └── install.journal.json
│   ├── current-identity.json
│   └── computer.terminal.json
└── workspaces/
```

`state/tat` 不属于 identity generation，换绑全程不移动、不删除、不重新注册。新旧 TAT runtime
不会并发，后台也只有同一个 TAT instance ID。

自动换绑前必须比较当前安装的 release version、target 与 program SHA-256 和 B enrollment 绑定值。
任一不同都在远端授权和本地写入前返回 `replacement_release_mismatch`；升级由独立流程完成，不能在
identity 换绑过程中覆盖正在运行的单二进制。

`replacement.journal.json` 不保存任何秘密，只保存 transaction ID、阶段、三份秘密文件名及各自
SHA-256。journal 与三份秘密文件都以 no-follow/create-exclusive 方式创建，要求当前用户所有、权限
`0600`；`~/.vela` 与 `state` 相关父目录要求当前用户所有、权限 `0700`。每次原子替换后同步文件与
父目录。恢复时先校验 owner、mode、普通文件、非链接、大小上限与摘要，任一不符即 fail closed。

`current-identity.json` 只保存当前 transaction ID 与 Computer route，不保存 secret。每个 identity
generation 先完整写入、逐文件 `fsync`，再同步 generation 目录；最后通过临时文件 + `fsync` +
单次原子 rename 切换 `current-identity.json`，并同步其父目录。

因此：

- pointer 切换前，daemon 只能读到完整 A identity；
- pointer 切换后，daemon 只能读到完整 B identity；
- 不移动整个 `state/`，不存在两次 rename 之间没有 canonical state 的窗口。

### Terminal marker

daemon 遇到普通平台鉴权失败时不得直接写 terminal marker。它调用空 body 的
preflight：

- `204`：继续现有 credential/session 恢复；
- `410 computer_removed`：原子写入与当前 identity 完全绑定的 terminal marker，停止平台重试和
  Agent Runtime，但保持唯一 TAT handle；
- `409/401/429/5xx/网络失败`：不写 terminal marker。

marker 包含 schema、Platform origin、server/computer ID、credential version、reason 和 observedAt，
权限 `0600`。只有所有 route 字段与 current identity 匹配时才能作为安装器的 removed 证据。

### 自动换绑流程

安装器发现 complete identity 后：

1. 获取稳定根锁 `~/.vela/install.lock`；
2. 验证新旧 Platform origin 完全相同；
3. 验证新 enrollment token 与旧 identity 属于同一 Server；
4. 通过只读 TAT inspection 取得 region/instance ID，使用旧 credential 与新 enrollment token 调用
   replacement preflight；即使已有 marker，也重新向后台取 grant；
5. active/not-current/invalid/unavailable 均在任何本地修改前退出；
6. removed 时创建无秘密的 replacement journal，并分别保存新 token、客户端新 secret、完整 grant
   三个 `0600` 秘密文件及其摘要；
7. 使用相同新 secret/digest 调用 replacement claim；
8. 将响应得到的 B identity 完整写入新 generation；
9. 原子切换 `current-identity.json`；
10. 删除 terminal marker；
11. 通知 daemon reload identity；daemon 保持现有 TAT handle，重建平台 Session 与 Assignment；
12. B 完成 Session、一次 Assignment snapshot 和 heartbeat 后，清除 replacement token/grant/旧
    credential secret，并结束事务。

旧 identity generation 在 B 健康前保留用于诊断，但绝不重新设为 current，因为 A 已 removed。
健康后只保留无 secret 的诊断摘要，删除旧 credential 和任何 replacement secret。

### 锁与 daemon 交接

`install.lock` 使用进程级 advisory exclusive lock：文件必须由当前用户拥有、普通文件、非符号链接、
权限 `0600`，打开时使用平台可用的 no-follow 语义。进程崩溃由内核释放锁。

- installer 持锁完成 journal、远端 claim、identity generation 与 pointer 切换；
- daemon 正常读 identity、保持 TAT 或 reload identity 不获取 install lock；
- installer 在 pointer 与 journal 都进入 `identity_switched` 后释放锁，再请求 daemon reload；
- daemon 启动恢复只有在发现未完成 journal 且成功取得同一根锁后才能修改事务；
- installer 不在持锁期间等待 daemon 健康，避免 installer→daemon 死锁；
- 第二条安装命令取得锁后若发现现有未完成 transaction，只能恢复同一 transaction 或返回
  `replacement_in_progress`，不得创建另一事务；
- daemon reload/健康成功后，完成者重新取得锁，校验 pointer transaction ID，再推进清理阶段。

### Replacement journal 与恢复

阶段：

```text
prepared → grant_issued → binding_reclaimed → identity_switched
         → daemon_reloaded → secrets_scrubbed → complete
```

每个阶段在对应副作用完成并持久化后推进。journal 自身使用原子写入和父目录同步。

- preflight 成功但 grant 响应丢失：重做 preflight；无数据库副作用；
- claim 成功但响应丢失：使用相同 token/digest 重放，取得相同 B route/version；
- generation 写入中崩溃：pointer 未切换，重建相同 transaction generation；
- pointer rename 成功但 journal 未推进：恢复器比较 pointer transaction ID 与 generation 完整性，
  收敛到 `identity_switched`，不得把 B 当作旧 identity；
- pointer 切换后 installer 崩溃：daemon 启动或下一条安装命令恢复相同 journal并 reload B；
- daemon 健康响应丢失：重复 Session/Assignment/heartbeat 检查，不重复 claim 或 identity reclaim；
- secret 清理失败：停留在 `daemon_reloaded`，重试删除与目录同步；只有清理成功才能 complete。

所有恢复决定都以 transaction ID、pointer 和完整 identity 内容为依据，不根据目录时间、PID 名称或
HTTP 状态猜测。

## 错误提示

- active：`Vela Computer is already installed and active for this macOS user.`
- not-current：`The existing Vela Computer credential is no longer current. Nothing was changed.`
- invalid：`The existing Vela Computer identity could not be verified. Nothing was changed.`
- unavailable：`Unable to verify the existing Vela Computer. Nothing was changed.`
- cross-server：`Automatic Computer replacement is only supported within the same Server.`
- release-mismatch：`Update Vela Computer before replacing this installation.`
- provider-gone：`The previous Computer provider identity no longer exists. Nothing was changed.`

提示不得包含 credential、token、grant、内部 ID 或服务端响应正文。

## 测试与验收

### 后台

- active current 返回 204；数据库与 last-seen 无写入。
- removed + 正确 secret 返回 `computer_removed`；错误 secret 仍为 invalid。
- active Computer 的轮换、过期和单独 revoked credential 均返回 not-current，不能取得 grant。
- missing route 和 wrong secret 使用相同响应 schema、大小和 dummy digest 路径，并做统计时序回归。
- 删除事务成功后 A removed 且无 current binding，registry 墓碑为 retired；任一分片失败则两边回滚。
- 普通数据清理不删除 retired/purged 墓碑；显式 provider purge 只能将 `retired` 原子转换为永久
  `purged`，任何路径都不得物理删除该 registry 行，暂时离线不能触发 purge。
- replacement grant 严格绑定 A/B、同一 server、revision、retired registry、generation 和 token hash。
- release version、target 或 program SHA-256 任一不匹配都不能取得 grant，也不能通过 claim 重验。
- 重新认领的 2PC 成功后 A removed 且无 current binding，B active 且持有原 TAT instance ID，
  registry active owner 精确为 B。
- claim 响应丢失后相同 digest 重放返回同一 credential；不同 digest 冲突。
- 崩溃后使用保存的完整 grant 恢复；过期 grant 只能命中已提交只读恢复分支，不能提交新事务。
- 跨 Server、stale revision、identity 已被他人认领、B 被不同 digest claim、未提交事务的 grant 过期
  全部拒绝。
- 普通 ComputerCredentialAuth 端点继续保持原兼容错误语义。
- SQLite 与 TDSQL/MySQL 运行相同语义测试；查询计划/审计证明 Server 查询带 `server_id`，registry
  查询带 `binding_hash`。

### Agent

- daemon 只对精确 `computer_removed` 写 marker；其他 401/409/5xx 均不写。
- marker 与 current identity 任一字段不匹配时无授权效果。
- active/not-current/invalid/unavailable 失败前后，identity pointer、credential、TAT state 和二进制 hash
  不变。
- removed 自动完成换绑，无交互和 `--force`。
- TAT identity inspection 只返回 region/instance ID；任何错误都不能泄露私钥或触发重新注册。
- B release 与当前二进制不一致时，在任何本地写入与 replacement 授权前拒绝。
- `state/tat` inode/content hash 在换绑前后不变，TAT handle 数量始终为一。
- 每个 journal 写入、generation 文件写入、pointer rename、父目录 sync、远端请求成功但响应丢失点
  注入崩溃，恢复后只有一个 transaction 和一个 B credential。
- 两条安装命令、LaunchAgent 启动与 installer 同时竞争时，无死锁、无第二事务。
- ENOSPC/EIO、PID 重用、符号链接、错误 owner/mode 均 fail closed。
- `~/.vela/workspaces` 内容、inode 路径与 hash 完全不变。
- complete 前后的 secret 清理失败可重试；complete 后不存在旧 credential、token 或 grant 明文。

### Canary

1. 安装 Computer A 并确认 online；
2. 在无绑定 Agent 时从 Web 删除 A；
3. daemon 确认 `computer_removed`、停止平台重试但保持一个 TAT handle；
4. 在同一 Server 创建 B 并执行安装命令；
5. B 自动重新认领 A 已退役的同一个 TAT instance ID 并 online；
6. A 保持 removed，旧 credential 不可用于业务端点；
7. 本地只有一个 daemon、一个 TAT runtime、一个 current identity；
8. 工作区与 TAT state hash 不变，replacement secret 已清理；
9. 对 active Computer、错误 secret、断网和跨 Server 分别验证拒绝且本地状态不变。
