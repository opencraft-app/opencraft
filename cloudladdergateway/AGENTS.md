# Cloud Ladder Gateway Agent Notes

- `cloudladdergateway` 是独立 Go module，入口在 `cmd/cloudladdergateway`。
- 协议真源是 `proto/cloudladdergateway/v1/gateway.proto`。
- 修改 proto 后运行 `PATH="$PATH:$(go env GOPATH)/bin" make generate`，生成物提交到 `gen/`，保证客户端可直接引用。
- 本地验证优先运行 `go test ./...`。
- Starlark 条件表达式必须只依赖请求/响应上下文，不要在规则里引入外部副作用。
- 强认证是核心能力；公网入口不能绕过 HMAC/mTLS 直接访问 IDC upstream。
- 审计日志是核心能力；代理路径必须记录 request id、caller、operation、upstream、status、latency、error 和请求摘要，并通过 stdout/OTLP logs 输出。
- 异步 webhook 目前是进程内 goroutine，不具备持久化重试；生产化前不要把它当可靠投递队列。
