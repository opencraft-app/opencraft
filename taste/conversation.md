# 会话与执行

会话、轮次、输入和执行尝试各有自己的标识与生命周期。把用户意图放进明确的类型。队列投递与向当前轮次补充输入有不同的前置条件，失败时也有不同的处理方式。

**现有模型。** 会话投递命令把队列模式和定向补充模式收窄成两种合法输入。

```ts
type DeliveryIntent =
  | { mode: "queue" }
  | { mode: "steer"; expectedTurnId: string };
```

解析发生在协议入口。执行边界用目标轮次或当前执行代次复核请求，轮次已换时返回明确的冲突。会话 owner 记录已接受的操作与其幂等键。取消、无法确认和执行失败分别映射到可观察的结果。

**如何验证。** 同一请求重试只产生一次操作。目标轮次变化后，补充输入请求返回冲突，队列里也不会多出一条输入。旧执行尝试的迟到回执不覆盖新尝试。

现有参考见 [投递解析](../packages/appserver-protocol/src/thread-command.mjs)、[投递类型](../packages/appserver-protocol/src/thread-command.d.mts) 和 [会话命令测试](../tests/identity/thread-cli.test.ts)。
