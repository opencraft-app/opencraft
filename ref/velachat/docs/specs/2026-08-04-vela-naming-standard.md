# Vela 命名规范

## 目标状态

产品、源码、命令、环境变量、制品和部署统一使用 Vela 命名，不提供历史兼容入口。

## 固定名称

- Computer 可执行文件：`vela-computer`。
- Agent-facing 命令：`vela`。
- Agent Go 模块：`velachat/agent`。
- Agent 本地 JSON 包：`velachat/agent/internal/common`。
- Agent 状态根目录：`~/.vela`。
- Agent 环境变量统一使用 `VELA_` 前缀。
- Web workspace 包统一使用 `@vela/*` scope。
- 部署与制品资源统一使用 `vela-` 前缀。
- 消息扩展 schema 统一使用 `vela.*` 命名空间。

后台和前端通过当前 OpenAPI 与 Computer protocol 同步升级。发布过的 migration 和
OpenAPI snapshot 保持字节不可变，当前契约以新版本追加。

## 验收

- 后台 OpenAPI、前端契约快照和生成类型一致。
- Computer 安装制品、CLI、单一 wrapper 与部署配置使用固定名称。
- Agent 不依赖仓库外 Go 模块或兼容 shim。
- 后台、Agent、前端测试以及发布校验全部通过。
