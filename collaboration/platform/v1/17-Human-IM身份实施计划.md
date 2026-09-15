# Human IM 身份实施计划

## 1. 目标

完成首个腾讯云 IM 真实闭环：

```text
注册
→ im.identity.ensure TencentOperation
→ IM Worker 导入普通 Human 账号
→ Account.imState=ready
→ GET /me
→ POST /me/im/session
→ 服务端签发短期 UserSig
```

本切片不实现 Server、Community/Topic、Agent、消息代理或聊天历史存储。

## 2. 固定设计

### 2.1 腾讯云边界

- 应用层只依赖 `IdentityProvisioner` 与 `UserSigIssuer` Port；
- 生产 `IdentityProvisioner` 调用
  `v4/im_open_login_svc/account_import`；
- 生产 `UserSigIssuer` 使用腾讯云 HMAC-SHA256 Go 实现；
- SDKAppID、管理员 UserID 和密钥由部署配置注入，密钥只从权限 `0600`
  的普通文件读取；
- UserSig、管理员 UserSig 和密钥不得进入日志、数据库、错误详情或测试夹具。

### 2.2 Worker

- v1 SQLite Worker 与 API 运行在同一进程；
- 每次只领取一个到期的 `im.identity.ensure`，使用短租约防止并发执行；
- 领取、成功、重试、失败都通过条件更新保证旧 lease 不能覆盖新 lease；
- 调用腾讯云前回读 Account，只有 `provisioning/error` 且 revision 匹配才执行；
- 腾讯账号导入成功后，在一个事务中更新：
  - Account.imUserId；
  - Account.imState=`ready`；
  - Account.revision+1；
  - TencentOperation=`succeeded`；
- 可安全重试错误进入 `retry_wait`，指数退避并带上限；
- 明确参数/权限/配额错误进入 `failed`，Account.imState=`error`；
- 超时或连接中断因账号导入本身幂等，允许重试，不进入 `uncertain`。

### 2.3 Human API

- `GET /v1/me` 只返回当前认证账号；
- `POST /v1/me/im/session` 不接受 userId/serverId；
- 只有当前 Account.imState=`ready` 且 imUserId 非空时才签发；
- 未就绪统一返回 `503/im_session_unavailable`；
- UserSig 默认 1 小时，响应带 `Cache-Control: no-store` 与
  `Pragma: no-cache`；
- UserSig 签发不写数据库，不引入第二种平台 Session。

## 3. 测试先行顺序

- [x] Port 与腾讯 REST Adapter：URL、请求体、HTTP 200 业务错误、重试分类；
- [x] UserID 派生与 UserSig Issuer：稳定性、字符集、TTL、敏感错误；
- [x] Worker Repository：租约、并发领取、成功事务、重试、终态失败、旧 lease；
- [x] Worker Service：当前事实回读、revision fencing、腾讯调用与状态归一；
- [x] `/me` 与 Human IM Session 应用服务和 strict HTTP Handler；
- [x] Bootstrap/CLI：安全配置、API+Worker 同进程、确定性 shutdown；
- [x] 全仓 test、race、vet、OpenAPI、凭证扫描和生成漂移门禁。

## 4. 验收

- 新注册账号最终从 `provisioning` 进入 `ready`；
- 腾讯云收到稳定 Human UserID，重复执行不会创建第二个身份；
- `/me` 能看到 `imState` 与 `imUserId`；
- 当前 Human 能取得仅属于自己的短期 UserSig；
- 未 ready、错误身份、撤销登录和伪造 userId 均不能取得 UserSig；
- Worker 重启、重复唤醒和并发领取不会产生错误终态覆盖；
- 没有任何真实腾讯云密钥或 UserSig 进入仓库和日志。

## 5. 实施结果

本切片已经完成。当前 `serve` 在同一 SQLite Handle 上运行 Human API 与 IM
Worker；注册写入的 `im.identity.ensure` 会被 Worker 领取并调用腾讯云
`account_import`，成功后将 Account 推进到 `ready`。认证 Human 随后可以通过
`GET /v1/me` 查看自身 IM 状态，并通过 `POST /v1/me/im/session` 获取仅属于当前
账号的短期 UserSig。

最终门禁通过：

- `go test ./...`；
- `go test -race ./...`；
- `go vet ./...`；
- Redocly OpenAPI lint；
- `go mod verify`；
- JSON fixture 校验；
- 凭证扫描；
- Ent/OpenAPI 生成产物漂移检查；
- 全仓 Go 格式检查。
