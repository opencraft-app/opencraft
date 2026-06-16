# Cloud Ladder Gateway Agent Notes

- `cloudladdergateway` 是独立 Go module，入口在 `cmd/cloudladdergateway`。
- 协议真源是 `proto/cloudladdergateway/v1/gateway.proto`。
- 修改 proto 后运行 `PATH="$PATH:$(go env GOPATH)/bin" make generate`，生成物提交到 `gen/`，保证客户端可直接引用。
- 本地验证优先运行 `go test ./...`。
- Starlark 条件表达式必须只依赖请求/响应上下文，不要在规则里引入外部副作用。
- 强认证是核心能力；公网入口不能绕过 HMAC/mTLS 直接访问 IDC upstream。
- 审计日志是核心能力；代理路径必须记录 request id、caller、operation、upstream、status、latency、error 和请求摘要，并通过 stdout/OTLP logs 输出。
- 异步 webhook 目前是进程内 goroutine，不具备持久化重试；生产化前不要把它当可靠投递队列。
- CI retrigger 约定：`.ci/cloudladdergateway.yml` 的 `paths` 仅匹配 `cloudladdergateway/**`，需要 retrigger 流水线但又没有真实代码改动时，可对本文件追加注记 commit。

<!-- retrigger 2026-06-16: MR !1591 (4365404cf28a) 已合 master 把 jifei-callback base_url 切到 https://lightclaw.tech 并同步 jifei-prod / jifei-billing-apigw-prod backend，但 tkexgz / tkexsg 两条 promote 分支 (451ba8ae1 / eb294a85d) 未自动合入 gitops，gitops 上 tkexgz/tkexsg 镜像仍 pin 在旧 commit `cloudladdergateway:3c8ed5ec86d7` (06-04)；本 commit 无业务改动，仅命中 .ci/cloudladdergateway.yml paths 触发流水线基于最新 gitops 重新生成 promote 分支 + MR，让 https://lightclaw.tech base_url 真正生效到两站点 clgateway -->
