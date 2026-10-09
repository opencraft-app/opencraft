# 本地完整开发栈规格

## 目标

用一个入口启动、停止和诊断 Go API 与 Expo Web，缩短本地界面、接口和腾讯云 IM 联调回路。生产部署、静态文件托管与本地调试保持分离。

## 入口

```text
./scripts/dev-local.sh setup
./scripts/dev-local.sh start
./scripts/dev-local.sh stop
./scripts/dev-local.sh restart [api|web|all]
./scripts/dev-local.sh status
./scripts/dev-local.sh logs [api|web|all]
./scripts/dev-local.sh doctor
```

`start` 默认启动：

- Go API：`http://127.0.0.1:18080`
- Expo Web：`http://127.0.0.1:8081`

脚本从自身位置确定后端目录，并优先使用 `VELA_WEB_DIR`；未设置时按当前工作区拓扑查找 `../../new-api/vela-web`。端口和监听地址可通过本地配置覆盖。

## 本地状态

所有运行时产物位于后端仓库的 `.local/dev/`：

```text
.local/dev/
├── config.env
├── data/chatserver.db
├── logs/api.log
├── logs/web.log
├── pids/api.pid
├── pids/web.pid
└── secrets/
    ├── jwt.key
    ├── im-identity.key
    └── im-secret.key
```

- `.local/` 必须被 Git 忽略。
- 目录权限为 `0700`，密钥文件为 `0600`。
- JWT 和 IM identity derivation key 由 `setup` 本地随机生成。
- 腾讯云 IM SecretKey 不写入源码、示例、命令行或日志；`setup` 仅从终端静默读取，或复用用户指定的受限密钥文件。
- 配置文件只保存非密钥配置和密钥路径。

## 生命周期

- `doctor` 检查 Go、Bun、前端目录、配置、密钥权限与端口占用。
- `start` 先启动 API，等待 `/healthz` 成功后再启动 Expo Web。
- 任一步失败都返回非零状态，并清理本次新启动的进程。
- PID 文件不仅检查进程存在，还校验命令行包含预期工作目录，避免误杀复用 PID。
- `stop` 先正常终止，超时后再强制结束，并移除陈旧 PID。
- `status` 同时报告进程与 HTTP 健康状态。
- `logs` 支持分别或合并跟踪两端日志。
- `restart api|web` 支持只重启正在调试的一侧，避免每次重建完整栈。

## 前后端边界

- API 不托管 SPA。
- Expo 通过 `EXPO_PUBLIC_VELA_API_URL` 连接本地 API。
- 后端 CORS 仍由应用配置控制；脚本不做代理、不改业务路由。
- 腾讯云 IM 消息仍由浏览器 SDK 直连；脚本只提供控制面 API 与 Web 开发服务器。

## 验收

- 全新目录执行 `setup` 后生成安全权限的本地状态。
- 缺少 IM SecretKey 时 `doctor/start` 给出中文可执行错误。
- 重复 `start` 幂等，不产生重复进程。
- `restart api` 不重启 Web；`restart web` 不重启 API。
- `stop` 后无存活子进程和陈旧 PID。
- `status` 在健康、未启动和陈旧 PID 三种情况下结果正确。
- 仓库凭证扫描不报告本地状态，源码中没有真实密钥。

