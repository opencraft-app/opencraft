# velagw

从 `wisp/velagw` 导入的 LLMGateway 控制面/数据面 subtree。

## 边界

- 这是 squash 风格 subtree，不是 module 或一次性拷贝。
- 模型/provider 运行时任务通过 `agent-gateway-runtime` 路由。
- 详细指引延后至 [velagw 服务详情](../docs/context/project/services/velagw.md)。
- 上游协作遵循 `velagw/MONO2_SUBTREE.md`。

## 命令

使用与变更 package 对应的服务本地 Makefile 或 Go test 命令；不得以无关的完整平台测试套件替代。

## 硬规则

- 与上游共享的变更必须用 `git subtree split --prefix=velagw` 切分。
- 不得因嵌入 mono2 就假设服务已接入 mono2 发布流水线。
- 没有路由级测试时，不得用本地兼容 shim 绕过 provider contract。
