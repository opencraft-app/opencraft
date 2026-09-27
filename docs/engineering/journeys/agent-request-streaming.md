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

Headless OpenCraft 的入口校验先于运行时健康判断：包内 Web release 必须声明 headless 构建身份和 `opencraft-server` Host 入口，否则即使同包 Codex AppServer 可启动，也不应让 Host 认领数据目录并对外提供 Web。打包、包级 smoke 和服务启动复用这一不变量；不要把通用 Web 构建的进程健康误判为 Codex 会话可用。

## 验证

覆盖普通响应、流式分片、客户端取消、provider 超时/限流、fallback、渠道发送失败和重连。OpenCraft 还必须覆盖 steer/queue 可见性、断线恢复不重复投影、完成瞬间组件身份和滚动所有权；工具终态必须有结果证据，不可恢复的资源缺失不得自动重连，Web/Expo 消息折叠需在宽度变化后重新测量自然高度。Host 从失败恢复到 ready 时应在无消息提交条件下重载 Catalog，BFCache 往返不得销毁应用所有权图。跨 gateway/runtime artifact 的变更分别验证镜像 pin 与 runtime SHA。

Web 图片附件的浏览器 `File` 与预览 URL 属于 Composer View/Controller 生命周期，不进入可序列化的 AppServer 请求或重放事件。异步图片处理必须按草稿和附件身份回写；切换目标不能串写，删除、清空或释放 Controller 后的迟到结果不能复活附件。发送后的图片只按已获准的会话媒体资源解析，并以可关闭、可恢复焦点的查看器呈现。
