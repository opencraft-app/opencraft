# Journey：Agent 请求与流式响应

## 目标

用户在 Web、桌面或渠道发起请求，系统找到正确实例和 runtime，经正确模型 provider 生成并持续返回结果。

## 链路

1. `frontend`/`velalink`/`opencraft` Workbench 或渠道客户端发起请求。OpenCraft 在客户端维护 Codex-compatible Turn/queue/steer 状态，并把 Hermes Desktop 事件语义投影成 AppServer 会话。
2. `service-gateway` 或 ChannelGateway 接收并路由到 Agent 控制/运行入口。
3. `ctl` 解析实例、渠道和运行时归属；`sandbox` 提供目标机器。
4. `cloudagent` gateway/Wisp 执行 Agent 调用。
5. `ai-gateway`、`velagw` 或 `new-api` 根据 contract 选择 provider 并处理流式/非流式响应。
6. CloudAgent/渠道把输出送回原入口；OpenCraft 以 durable replay 游标和同生命周期投影状态去重、续接并完成 Turn，`workers` 可承担异步恢复作业。

## 诊断顺序

按“入口是否收到 → 编排是否找到实例 → runtime 是否健康 → provider 是否生成 → 流/渠道是否送出”定位，不从最终沉默直接归因模型。每层使用同一 request/session/instance 关联标识，日志不得包含密钥或完整敏感内容。

## 验证

覆盖普通响应、流式分片、客户端取消、provider 超时/限流、fallback、渠道发送失败和重连。OpenCraft 还必须覆盖 steer/queue 可见性、断线恢复不重复投影、完成瞬间组件身份和滚动所有权；工具终态必须有结果证据，不可恢复的资源缺失不得自动重连，Web/Expo 消息折叠需在宽度变化后重新测量自然高度。跨 gateway/runtime artifact 的变更分别验证镜像 pin 与 runtime SHA。
