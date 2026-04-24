# api-gin 开发规范

目标：用 gin 适配 `openapi.yaml` 的沙箱创建/销毁接口，复用主项目的业务逻辑（Service + Store），最少复制代码；接口模型由 `oapi-codegen` 生成（仅包含 sandboxes 相关 tag）。

## 目录结构
- `main.go`：入口，加载配置，启动 HTTP 服务器。
- `handler.go`：`oapi-codegen` 生成的 `ServerInterface` 实现（只实现 sandboxes 相关操作，其余返回 501）。
- `config.go`：环境变量到配置 + Store 选择。
- `Makefile`：常用命令。
- `gen/`：`oapi-codegen` 生成的类型与 gin 路由绑定（沙盒相关 tag）。

## 运行
```bash
cd api-gin
# 重新生成（仅 sandboxes tag）
make generate
# 启动
API_ADDR=:8081 MYSQL_DSN="user:pass@tcp(host:3306)/cvm?parseTime=true" make run
# 若未配置 MYSQL_DSN 将退回内存存储（仅测试用）。
```

## 端点（与 openapi 沙盒相关子集）
- `GET /health`
- `GET /sandboxes`：列出实例（跨池）。
- `POST /sandboxes`：分配一台 CLEAN -> ALLOCATED；传 `templateID` 时固定池，不传时走超级池随机跨池重试。
- `DELETE /sandboxes/:sandboxID`：释放 ALLOCATED -> DRY（重装由 worker 处理）。
- `GET /sandboxes/:sandboxID`：返回 sandbox detail（使用占位字段补全必需项）。
- 其他 sandboxes 相关操作（logs/pause/resume/timeout/v2）当前返回 501。

## 开发约定
- 复用 `internal/service` + `internal/store`，不要在 handler 里写状态机逻辑。
- 错误码映射：
  - `ErrNoCleanInstance` -> 409 conflict
  - `ErrInstanceNotFound` -> 404
  - `ErrInvalidTransition` -> 409
  - 其余 -> 500
- 新增字段/行为需同步 `openapi.yaml` 并更新 README/AGENTS。
- 本地快速验证：`go test ./...`（api-gin 目录）或对上游服务使用 curl：
```bash
curl -s http://localhost:8081/sandboxes | jq .
curl -s -X POST http://localhost:8081/sandboxes | jq .
curl -s -X DELETE http://localhost:8081/sandboxes/<id> | jq .
```

## 待办/扩展
- 路径参数选择池（与 openapi 模型对齐）。
- 身份认证、中间件（按 `components.securitySchemes`）。
- 日志/指标：接入 Prometheus 与 structured logging。
- 补全 sandboxes 其他操作的真实实现（logs/pause/resume/timeout/v2）。
