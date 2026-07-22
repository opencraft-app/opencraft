# 流量面 ReverseProxy 重构设计

## 目标

LLMGateway 继续负责鉴权、Redis 路由、Set runtime 代际和 BYOK 策略；HTTP
响应转发改由 Go 标准库 `httputil.ReverseProxy` 负责。删除手写 header 清理、SSE
flush 和响应体复制，避免把正常客户端取消误记为 `response_copy_error`。

本次重构保持现有业务语义：BYOK 首选模式收到 `401`、`403`、`429` 或任意
`5xx` 时，最多使用平台 Key 再请求一次。BYOK 已返回 `200` 并开始响应体传输后
不再降级。

## 组件边界

### ProxyHTTP

1. 从 Redis 获取外部 Key 和 Set runtime 快照。
2. 校验租户、Set 和 runtime 是否允许承载流量。
3. 选择 `(set_id, route_revision)` 对应的连接池。
4. 为 BYOK fallback 请求准备可重放且有大小上限的请求体。
5. 将不可变的 route plan 放入请求上下文，调用一个可复用的 ReverseProxy。

### ReverseProxy

- `Rewrite` 根据 route plan 设置目标 URL、Host 和上游 Authorization。
- `Transport` 使用 route plan 已选定的 RoundTripper；BYOK 首次请求失败时，在
  响应暴露给 ReverseProxy 前执行一次平台 Key fallback。
- `ModifyResponse` 记录最终上游状态和 SSE 属性。
- `ErrorHandler` 只处理响应头尚未提交时的 RoundTrip 错误。
- 标准库负责 hop-by-hop header、trailers、101 upgrade、SSE flush 和响应复制。

### 观测语义

- 正常读到 EOF：请求成功。
- 客户端取消由标准 HTTP server 结束请求，不设置业务 `error_type`；可单独计入
  低优先级 `client_cancelled` 指标，但不进入上游错误率。
- 最终上游 `4xx/5xx` 继续按现有状态分类。
- fallback 成功保留 `byok_platform_fallback` 标记。
- 响应头提交前的网络错误由 `ErrorHandler` 记录为明确的 RoundTrip 错误。

## 约束

- traffic 继续 Redis-only，不访问 MySQL。
- 不解析 OpenAI、Anthropic 或其他模型响应 payload。
- 不为每个请求创建独立连接池；继续复用 `TransportManager`。
- 仅 BYOK fallback 请求需要缓冲请求体，其他流量保持流式转发。
- fallback 最多两次总尝试，不增加通用重试。

## 验证

- 普通请求的 URL、query、headers、status 和 body 保持透明。
- SSE 每个事件及时 flush，完整读取不产生错误。
- 客户端收到事件后取消，不产生 `response_copy_error`。
- BYOK 对 `401/403/429/5xx` 触发一次平台请求，其他状态不触发。
- fallback 请求体完全一致，最终只向客户端发送一份响应。
- route revision 切换后使用新连接池，已有请求不被取消。
- hop-by-hop headers、trailers 和客户端取消行为由标准库回归测试覆盖。
