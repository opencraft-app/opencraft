# 独立 Codex 核心服务设计

独立服务承载原生 Codex 执行，使页面、网关与 daemon 的生命周期不再决定活动
Turn、原生 queue 或 goal 的生命周期。Codex 在这里是实际执行引擎名称。
当前构建、启动、维护、回退与验证契约见[服务器 Codex 核心服务](../../docs/codex-core.md)。

## 所有权

- [核心进程](../../apps/codex-core/src/main.ts)持有 CLI、账户池和维护生命周期。
- [引擎适配器](../../apps/opencraft-daemon/src/codex-engine-adapter.ts)持有逻辑客户端映射、初始化、订阅与 OpenCraft Host 能力。
- [账户服务](../../packages/account-pool-host/src/codex-account-service.ts)管理账户元数据、私有凭据和维护请求；内嵌与独立 core 复用同一实现。
- [桌面 daemon 客户端](../../apps/workbench-electron/src/daemon-client.ts)透传显式 core endpoint；默认内嵌模式保持独立。

## 设计约束

- 使用原生 Unix WebSocket 和独立 Unix HTTP 控制接口，复用 daemon token；不增加执行调度层。
- 数据目录使用 SQLite EXCLUSIVE 持有式事务保证单 writer；Linux 额外检查占用相同 `CODEX_HOME` 的旧版或孤儿 CLI，不删除活进程的锁文件。
- core 不可用时明确失败，不启动第二个 writer，不自动重放结果未知的写入。
- 关闭服务时等待账户请求、用量维护与代理异步处理结束，再释放存储和 writer 锁。
- 网页、网关和 daemon 的普通升级与 core/CLI 维护分别处理；core 重启仍可能中断任务。

## 验证范围

核心验证应覆盖零客户端生命周期、账户控制鉴权、重复 writer 拒绝、订阅隔离、
不可用时不回退，以及隔离真实 CLI 和本地合成模型下跨 daemon 重启的任务连续性。
具体命令和验收证据要求由[当前服务文档](../../docs/codex-core.md#验证)维护。
本设计说明不代表当前版本或某个实际部署已经通过这些验收。
