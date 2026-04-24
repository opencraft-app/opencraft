上海环境的部署事实会在首次 `cd infra_pulumi && GOWORK=off go run ./cmd/infractl up --stack shanghai-sandbox` 后自动回写到这个目录。

- `platform.env`: 由 `cd infra_pulumi && GOWORK=off go run ./cmd/infractl sync --stack shanghai-sandbox` 生成
- `secrets.example.env`: 需要由本地 `.secret/` 或其他 secret 存储提供的敏感项说明

约束：

- 这里不存真实密码、Token、Key
- 路径类变量默认相对 mono repo 根目录解析
- `platform.env` 不要手改
