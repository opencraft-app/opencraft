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
- 现有 TAT 外部纳管实例代表物理机器，换绑时直接从 A 转移给 B；不创建第二个 TAT identity。
- `~/.vela/workspaces` 永远不参与换绑。

## 目标

- 只有持有正确旧 credential，且后台确认旧 Computer 已 `removed` 时才自动换绑。
- credential 轮换、自然过期、单独撤销、网络失败和身份损坏都不能授权换绑。
- 沿用现有 `Authorization: ComputerCredential <crc_...>`，不引入第二套长期身份。
- 后台在同一 `server_id` 分片事务内完成新 enrollment claim 与 TAT binding 转移。
- Agent 保留现有 `state/tat` 和唯一 TAT runtime，仅原子切换平台 identity generation。
- 远端请求成功但响应丢失、进程崩溃或机器重启后可以恢复同一换绑事务。
- credential、setup token 和 replacement grant 不进入日志、URL、trace 或测试夹具。

## 非目标

- 不支持跨 Server 自动转移 TAT binding；这会成为跨分片事务。
- 不把 active Computer 的旧 credential 自动修复为新 credential。
- 不远程卸载真实机器，不删除工作区。
- 不新增数据库表，不改变现有 `server_id` 分片键。
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
查询。返回值包含 secret digest、credential state/expiry、Computer lifecycle/revision 及 TAT binding。

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

请求没有 body。响应：

- `204 No Content`：Computer active 且 credential current；
- `410 application/json`，code=`computer_removed`：secret 匹配且 Computer removed；
- `409 application/json`，code=`computer_credential_not_current`：Computer active，但 credential
  不是 current；
- `401 application/json`，code=`computer_credential_invalid`：路由或 secret 无法证明；
- `429/5xx`：统一标准错误。

错误响应必须使用现有 `Error` schema，固定 `application/json`，并带 `no-store/no-cache`。
preflight 不签发 Session、不更新 last-seen、不写业务表，也不返回 Server、Computer、租户或用户信息。

### Replacement grant

安装器已经持有 B 的 enrollment token。为了在 claim 时原子重验 A 与 B，preflight 支持一个可选的
敏感请求头：

```text
X-Vela-Replacement-Enrollment: <B enrollment token>
```

该 header 必须加入反向代理、HTTP middleware、trace 和错误日志的强制脱敏表。

当且仅当以下条件同时满足时，`410 computer_removed` 响应额外返回短期
`replacementGrant`：

- A 的旧 credential secret 摘要匹配；
- A 为 removed 且仍保存一个 managed TAT binding；
- enrollment token 指向同一 `server_id` 下、处于 provisioning 且未 claim 的 B；
- B 的 generation、release 与 enrollment token 完全匹配。

grant 使用现有后台签名基础设施，但具有独立 audience `computer-replacement`、5 分钟 TTL，并绑定：

- old/new server ID 和 Computer ID；
- old lifecycle revision、credential version 和 TAT instance ID；
- new enrollment generation 与 token hash。

grant 是短期一次用途 capability，不是新的登录身份。签发 grant 不写数据库。

### Claim 与 TAT binding 原子转移

现有 `/computer/enrollments:claim` 请求增加可选 `replacementGrant`。没有该字段时保持首次安装语义。

有 replacement grant 时，Repository 在一个 `server_id` 分片事务内：

1. 验证 grant 签名、audience、有效期与 enrollment token hash；
2. 锁定 A、B、A 的证明 credential 和 B 当前 enrollment；
3. 重验 A 仍 removed、revision 未变化、TAT binding 与 grant 一致；
4. 重验 B 仍 provisioning、未 claim、generation/token/release 一致；
5. 使用现有 credential digest 规则 claim B；
6. 将 A 的 `tat_instance_id/region/kind` 转移给 B，并从 A 清除当前 binding；
7. 将 B lifecycle 置为 active，保留 A 的 removed 墓碑与 credential 证明；
8. 提交事务后返回 B 的 credential route/version 和 `providerBinding=reused`。

事务禁止跨 Server。TAT instance ID 是 backend 定位腾讯云实例的真相源；旧 Tag 可以由现有
Tencent operation 异步刷新，但 Tag 更新失败不影响授权、命令路由或换绑正确性。

### 幂等规则

B enrollment token、generation 与客户端生成 credential digest 继续构成现有幂等 claim 身份。

- 首次事务成功：创建 B credential 并转移 binding；
- 成功响应丢失后重放：如果 B 已以相同 digest claim，返回同一 route/version；不再次转移；
- 相同 token、不同 digest：冲突；
- grant 过期但事务已经成功：现有 claim 恢复分支仍可返回相同 B credential；
- grant 过期且事务从未成功：要求重新 preflight 取得新 grant；
- A binding 已被其他事务移动、revision 改变或 B 已被其他 digest claim：冲突，不猜测恢复。

数据库需要继续具备 `server_id + computer_id + version` credential 唯一性和 Computer 主键唯一性；
不新增全局唯一索引，不执行跨分片 CAS。

## Agent 设计

### Identity generation 与 TAT state 分离

端侧状态调整为：

```text
~/.vela/
├── install.lock
├── replacement.journal.json
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

`current-identity.json` 只保存当前 transaction ID 与 Computer route，不保存 secret。每个 identity
generation 先完整写入、逐文件 `fsync`，再同步 generation 目录；最后通过临时文件 + `fsync` +
单次原子 rename 切换 `current-identity.json`，并同步其父目录。

因此：

- pointer 切换前，daemon 只能读到完整 A identity；
- pointer 切换后，daemon 只能读到完整 B identity；
- 不移动整个 `state/`，不存在两次 rename 之间没有 canonical state 的窗口。

### Terminal marker

daemon 遇到普通平台鉴权失败时不得直接写 terminal marker。它调用无 replacement header 的
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
4. 使用旧 credential 与新 enrollment header 调用 preflight；即使已有 marker，也重新向后台取 grant；
5. active/not-current/invalid/unavailable 均在任何本地修改前退出；
6. removed 时创建 replacement journal，保存新 token、客户端新 secret、grant 摘要和 transaction ID；
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
prepared → grant_issued → binding_transferred → identity_switched
         → daemon_reloaded → secrets_scrubbed → complete
```

每个阶段在对应副作用完成并持久化后推进。journal 自身使用原子写入和父目录同步。

- preflight 成功但 grant 响应丢失：重做 preflight；无数据库副作用；
- claim 成功但响应丢失：使用相同 token/digest 重放，取得相同 B route/version；
- generation 写入中崩溃：pointer 未切换，重建相同 transaction generation；
- pointer rename 成功但 journal 未推进：恢复器比较 pointer transaction ID 与 generation 完整性，
  收敛到 `identity_switched`，不得把 B 当作旧 identity；
- pointer 切换后 installer 崩溃：daemon 启动或下一条安装命令恢复相同 journal并 reload B；
- daemon 健康响应丢失：重复 Session/Assignment/heartbeat 检查，不重复 claim 或 binding transfer；
- secret 清理失败：停留在 `daemon_reloaded`，重试删除与目录同步；只有清理成功才能 complete。

所有恢复决定都以 transaction ID、pointer 和完整 identity 内容为依据，不根据目录时间、PID 名称或
HTTP 状态猜测。

## 错误提示

- active：`Vela Computer is already installed and active for this macOS user.`
- not-current：`The existing Vela Computer credential is no longer current. Nothing was changed.`
- invalid：`The existing Vela Computer identity could not be verified. Nothing was changed.`
- unavailable：`Unable to verify the existing Vela Computer. Nothing was changed.`
- cross-server：`Automatic Computer replacement is only supported within the same Server.`

提示不得包含 credential、token、grant、内部 ID 或服务端响应正文。

## 测试与验收

### 后台

- active current 返回 204；数据库与 last-seen 无写入。
- removed + 正确 secret 返回 `computer_removed`；错误 secret 仍为 invalid。
- active Computer 的轮换、过期和单独 revoked credential 均返回 not-current，不能取得 grant。
- missing route 和 wrong secret 使用相同响应 schema、大小和 dummy digest 路径，并做统计时序回归。
- replacement grant 严格绑定 A/B、同一 server、revision、TAT binding、generation 和 token hash。
- 同分片事务成功后 A removed 且无 current binding，B active 且持有原 TAT instance ID。
- claim 响应丢失后相同 digest 重放返回同一 credential；不同 digest 冲突。
- 跨 Server、stale revision、binding 已移动、B 已 claim、grant 过期全部拒绝。
- 普通 ComputerCredentialAuth 端点继续保持原兼容错误语义。
- SQLite 与 TDSQL/MySQL 运行相同测试；查询计划/审计证明所有 replacement 查询带 server_id。

### Agent

- daemon 只对精确 `computer_removed` 写 marker；其他 401/409/5xx 均不写。
- marker 与 current identity 任一字段不匹配时无授权效果。
- active/not-current/invalid/unavailable 失败前后，identity pointer、credential、TAT state 和二进制 hash
  不变。
- removed 自动完成换绑，无交互和 `--force`。
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
5. B 自动接管 A 的同一个 TAT instance ID 并 online；
6. A 保持 removed，旧 credential 不可用于业务端点；
7. 本地只有一个 daemon、一个 TAT runtime、一个 current identity；
8. 工作区与 TAT state hash 不变，replacement secret 已清理；
9. 对 active Computer、错误 secret、断网和跨 Server 分别验证拒绝且本地状态不变。
