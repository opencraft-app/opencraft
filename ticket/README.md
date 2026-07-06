# ticket

LightVela 反馈/工单系统后端服务。

## 目录

- `cmd/ticket/`          HTTP 服务入口
- `cmd/ticket-migrate/`  DB 迁移入口
- `api/`                 OpenAPI 定义 + oapi-codegen 配置
- `internal/config/`     配置加载
- `internal/store/`      MySQL 数据层
- `internal/service/`    业务层
- `internal/httpapi/`    HTTP 路由 + handler
- `migrations/`          SQL 迁移脚本

## 运行

```bash
# 本地
TICKET_MYSQL_DSN="ticket:pw@tcp(127.0.0.1:3306)/lightvela_ticket?parseTime=true" \
TICKET_ADMIN_TOKEN=dev-token \
go run ./cmd/ticket

# 迁移
go run ./cmd/ticket-migrate up
```

## 配置（环境变量）

| 变量 | 说明 |
|------|------|
| `TICKET_ADDR` | 监听地址，默认 `:8090` |
| `TICKET_MYSQL_DSN` | MySQL DSN，指向 `lightvela_ticket` |
| `TICKET_ADMIN_TOKEN` | 受理后台内网 token |
| `TICKET_ALLOWED_ORIGINS` | CORS 白名单，逗号分隔 |
| `SUPPORT_COS_BUCKET_URL` | 反馈桶地址，形如 `https://<bucket>.cos.<region>.myqcloud.com`（由部署侧 Secret 注入，未写死） |
| `SUPPORT_COS_SECRET_ID` / `SUPPORT_COS_SECRET_KEY` | 反馈桶私有凭证（Secret 注入，前端永不持有） |
| `SUPPORT_COS_PREFIX` | 桶内前缀，默认 `support-feedback` |
| `SUPPORT_COS_ACCELERATE` | `true` 开启 COS 全球加速：前端上传/下载走 `cos.accelerate` 公网域名。**必开** |
| `SUPPORT_COS_INTERNAL` | `true` 开启全球内网加速：仅服务端读桶走 `cos-internal.accelerate`（要求本服务在腾讯云内网 VPC）。**非内网机器切勿开启** |
