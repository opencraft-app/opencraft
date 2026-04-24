# APIErrorRateHigh

先看 `openclaw_api_request_total` 的 `status_code` 和 `path` 分布，定位异常接口，再结合 API 日志与 tracing 判断是参数错误放大、下游故障还是服务本身回归。
