# Computer Session 租约简化设计

## 问题

Computer 创建短期 Session 时，`UseCurrentCredential` 已验证长期凭据并更新
`computer_runtime_credentials.last_used_at`。随后 `RefreshSessionLease` 又以同一个时间
重复更新该字段，并用影响行数判断凭据是否存在。TDSQL/MySQL 对无变化更新返回零行，
导致有效凭据被误判为已撤销，Computer 无法写入 `host_last_seen_at`。

## 领域边界

保留三个必要事实：

- Computer Credential：长期身份及其当前性；`last_used_at` 由凭据验证步骤维护。
- Computer Session：后台签发的短期访问令牌。
- Computer Host Lease：daemon 成功取得 Session 后的在线租约；由
  `computers.host_last_seen_at` 表示。

同一个字段只有一个写入者。Session 租约刷新不得再次写 Credential 使用时间，也不得
依赖数据库对 no-op UPDATE 的影响行语义。

## 实现

`RefreshSessionLease` 在一个数据库事务内，固定按 Credential、Computer 的顺序锁定
两条精确记录：

1. 锁定并确认指定 Server、Computer、版本的 Credential 仍处于 active/grace 有效期；
2. 锁定并确认 Computer 仍为 active；
3. 仅当新时间更晚时更新 `computers.host_last_seen_at`；相同或更早时间视为幂等成功；
4. 只有目标不存在或已失效时返回 `ErrCredentialNotCurrent`。

TDSQL/MySQL 使用行锁，SQLite 依靠现有单写事务串行化。Credential 轮换、撤销和 Computer
移除继续遵循 Credential 后 Computer 的控制面锁序。租约是否成功由锁内读取的领域状态
决定，不由任何 UPDATE 的 changed-row count 决定。

`UseCurrentCredential` 继续负责更新 `last_used_at` 并返回一致的 Assignment Fence。公开接口、
数据表和 Agent 协议均不变化。

## 选择

- 采用：移除租约步骤的重复 Credential UPDATE，以存在性查询确认 currentness。
- 不采用：接受 UPDATE 影响行数为零。这样无法区分“值未变化”和“目标不存在”。
- 不采用：增加数据库方言分支或人为改变时间戳。这会把领域错误变成数据库 workaround。

## 验收

- 相同时间连续完成 Credential 使用和 Session 租约刷新仍成功；
- 相同租约时间重复刷新成功，较旧请求不得让租约倒退；
- Credential 失效、过期或 Computer removed 时拒绝刷新；
- Credential revoke/rotate 或 Computer remove 与刷新并发时，结果按锁顺序线性化；
- 成功创建 Session 后写入 `host_last_seen_at`，管理端投影为 online；
- SQLite 测试、TDSQL/MySQL 行为测试、全量测试与静态检查通过。
