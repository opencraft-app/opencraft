# Workers API 在途业务排空资格

这个独立门禁测试真实 Worker 业务，而不只是 `/readyz`。它上传一个无 Durable Object 的临时
Worker，经公共 `/v1` 激活，然后让选定 API Pod 转发一个持续 35 秒的固定 128 KiB 响应。
收到前 64 KiB 后，门禁按 Pod UID 发起正常优雅删除，不改变生产 30 秒 preStop、50 秒 grace
或十秒 HTTP 排空期限。

成功必须同时证明：容器拒绝新连接时原请求仍未完成；随后原请求收到完整内容，没有重试；
公共私网 CLB 的独立快速业务请求持续成功；旧 UID 消失、新 UID Ready，至少三个 API 副本
落在三个节点；Deployment/HPA 身份、策略和精确镜像不变；临时 Worker 被删除。

长流与 admission 探测使用两个独立 port-forward。否则探测到拒绝连接时 kubectl 可能关闭
整个转发会话，连带中断长流。门禁等待独立探测进程的容器 `connection refused` 事件，不能
把任意网络超时当作 listener 已关闭。收据原子创建，不覆盖旧成功或失败证据。

HTTP framing 可为固定 Content-Length 或 chunked；两者都必须完整接收并逐字节核验固定
128 KiB 内容和 EOF。不能只靠 Content-Length 判断成功。workerd 对普通 ReadableStream
会生成 chunked framing，手工设置长度不决定线上 header；这是
[Workers Response 的原生行为](https://developers.cloudflare.com/workers/runtime-apis/response/)，
并且当前 `host/src/stateless.rs` 的流式代理显式去除 Content-Length。这不是应通过修改
生产代理来修复的错误。

在同 VPC 的已审阅 builder 上运行；入口持有整个共享 operation lock：

```bash
ACTOR_REVIEWED_SOURCE=/var/lib/actor-build/deploy/q01-src-<revision>-<manifest> \
  bash ./run-on-builder.sh <32-hex-run-id> <reviewed-api-image@sha256:digest>
```

输出在 `load-tests/workers-api-business-drain-<run-id>/`。使用当前正式发布的 API image，不能
临时构建一个不同镜像或关闭 HPA 来通过此门禁。本地回归覆盖真实 HTTP 流、截断、真实
kubectl 协议子进程的 UID precondition、生成的 JS 和原子收据；它们不能替代云上排空收据，
此单 Pod 门禁也不替代万级活跃对象、持续扩缩容或内部 Router 的独立业务资格。
