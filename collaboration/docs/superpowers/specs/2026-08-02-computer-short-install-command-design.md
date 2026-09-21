# Computer 短安装命令设计

日期：2026-08-02

## 目标

Human 只看到以下形式的一键安装命令：

```sh
curl -fsSL https://computer.example.com/install | sh -s -- ABCD-EFGH-JKLM-NPQR
```

短码为 16 位 Crockford Base32，按四组四位展示，约 80 bit 随机强度。现有完整
Enrollment Token、HTTPS 限制、制品摘要/签名验证、私有临时目录和失败清理继续保留，
但不再展开到 Human 命令中。

## 外部协议

- `GET /install`：公开返回稳定、无凭证的 POSIX Bootstrap，`Cache-Control: no-cache`。
- `POST /v1/computer/setup-codes:redeem`：请求体是规范化前的短码文本，响应为仅供当前
  安装进程执行的第二阶段 POSIX shell，所有响应使用 `Cache-Control: no-store`。
- Bootstrap 从 `$1` 读取短码，经 `printf | curl --data-binary @-` 发送；短码不写入临时
  文件、不进入 URL、Header 或环境变量。
- 第二阶段脚本包含现有完整 Enrollment Token，并负责将它写入 `0600` 临时文件、下载并
  校验固定 `install.sh` 后执行。临时目录在退出或信号中清理。

## 数据模型与路由

新增短期 `computer_setup_codes` 索引：

- `id`：UUIDv7 业务主键；
- `code_hash`：规范化短码 SHA-256，唯一索引和 TDSQL 分区键；
- `server_id`、`computer_id`、`generation`：现有 Enrollment 路由；
- `expires_at`、`created_at`：有效期和清理依据。

数据库不保存短码或完整 Enrollment Token 明文。后台使用请求中的规范化短码和索引中的
路由，以域分隔 SHA-256 确定性派生现有 `cen1` Token 的 32 字节 secret；Computer 行仍只
保存完整 Token SHA-256。

短码索引和 Computer 位于不同分区，不建立跨分片事务：先用现有 revision/generation CAS
创建新 Enrollment，再创建短码索引。第二步失败时本次 generation 不会被暴露，Human
重试会生成下一 generation。旧索引兑换时仍必须到 `server_id` 分片校验当前 generation、
Token hash、过期时间和未 claim 状态，因此重签或 claim 后自然失效。

## 生命周期与安全

- 默认 15 分钟有效，继续受当前 Enrollment TTL 上限约束。
- “一次性”表示只绑定一个 Computer generation；为容忍网络截断，在 claim 前允许同一
  短码重复兑换相同第二阶段脚本。
- claim 成功、Computer online、过期或重新生成命令后均拒绝兑换。
- 规范化只接受 16 个 Crockford Base32 字符；忽略大小写和连字符，拒绝易混淆字符
  `I/L/O/U`、空白和其他分隔符。
- 短码、完整 Token、第二阶段响应体不得进入访问日志、错误、Operation、fixture 或指标。
- 兑换按客户端 IP 与 `code_hash` 限流；错误统一返回不可枚举的 `setup_code_invalid`。

## 产品与兼容边界

- Computer Setup API 只返回 `command/expiresAt/generation/revision`，不再向 Human 返回完整
  Enrollment Token。
- 当前 `claim` 和私有 artifact 路由保持不变；稳定 Bootstrap 只是把短码兑换为现有协议，
  不重写 Computer 安装器。
- 首版继续只发布已存在的 macOS ARM64 target，不增加平台选择或 Agent 一键创建。
- 本轮只做本地实现与验证，不发布 Canary。

## 验收

- 生成命令严格匹配短命令形态，包含 16 位分组短码，不包含 `cen1`、Computer/Server UUID、
  artifact 路由、摘要或临时目录细节。
- Bootstrap 不把短码写盘；第二阶段仍先验证 installer SHA-256 再执行。
- 测试覆盖短码规范化、熵源失败、哈希存储、失效 generation、过期、claim 后拒绝、重复
  兑换、错误不可枚举、无日志泄漏、SQLite/TDSQL migration 与单分片后续读取。
- OpenAPI、生成代码、Web/TUI 展示、全量 Go/Expo 测试、race、vet、生成一致性和凭证扫描
  全部通过。
