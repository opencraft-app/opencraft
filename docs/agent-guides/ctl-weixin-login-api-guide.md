# CTL Weixin Login API Guide

本文件面向需要理解或对接 `ctl` 微信扫码登录能力的 Agent。重点是：

- 接口怎么调用
- 状态怎么流转
- 前端怎么消费 `snapshot + SSE`
- 当前能力和限制是什么

本文件不是本地排障文档。若需要本地启动、`port-forward`、排查 sandbox 联调问题，改看 [docs/agent-guides/ctl-local-run-guide.md](ctl-local-run-guide.md)。

当前状态说明：

- 微信登录能力现在依赖镜像内正式协议命令 `openclaw-weixin-login-session`
- `ctl` 已切到结构化 `start/status/cancel` 协议，不再以 PTY 原始输出作为主事实源
- 当前测试环境 pool 已可以全量统一镜像，但仍应以 `pools.base_image` 的实时查询结果为准，不要靠历史文档假设命中的是哪一个版本
- 因此，看到微信登录失败时，先确认实际命中的 pool 与当前 `base_image`，不要跳过现网查询
- 如果任务涉及当前镜像构建、运行时安装路径或默认插件集合，应优先参考 [docs/agent-guides/sandbox-image-agent-guide.md](sandbox-image-agent-guide.md)

## 0. 排障优先级

如果真实链路里出现：

- `Channel login failed: Error: Unsupported channel: openclaw-weixin`

优先排查顺序应是：

1. 先看实例命中的 pool 和 `base_image`
2. 再看实例内 `/etc/lightclaw/image-version`
3. 再看实例内 `openclaw plugins list`
4. 最后才回头怀疑 `ctl` 的 create-session / snapshot / SSE 链路

原因：

- 这类报错通常说明 `ctl` 控制面本身已经把 session 和 SSE 跑起来了
- 真正失败点往往是 sandbox 实例运行时没有装 `openclaw-weixin`
- 如果 snapshot / SSE 首帧已经正常返回，说明 CTL API 大概率不是第一嫌疑对象

## 1. 目标模型

微信扫码登录不是“执行一个短命令并同步返回结果”，而是一个会话型流程：

1. 创建 login session
2. 后端在 sandbox 内调用 `openclaw-weixin-login-session start`
3. 后端轮询 `openclaw-weixin-login-session status`
4. 一旦拿到二维码，尽快返回给前端
5. 前端持续订阅状态变化
6. 用户扫码成功后，后端自动执行 `openclaw gateway restart`

当前实现的事实源：

- 镜像协议返回的结构化 JSON
- 实例内 `/tmp/lightclaw-weixin-login/<session_id>/state.json`

其中：

- `qr_ascii` 仍是最可靠的展示字段
- `qr_url` 是辅助字段，不应当成二维码图片 URL

当前已验证：

- `qr_ascii` 是最可靠、最适合前端直接展示的字段
- `qr_url` 会一并返回，但它是微信扫码落地页 URL，不是二维码图片 URL

## 2. API 列表

### 2.1 创建登录会话

`POST /v1/instances/{id}/channels/weixin/login-sessions`

请求头：

- `X-User-Id`

响应示例：

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "session_id": "wxlogin_bbb4c7a856ce4d0eba11fe4c9bb70b60",
    "status": "starting"
  }
}
```

说明：

- 一个实例同一时间只允许一个 active 的微信登录 session
- 如果已有未完成 session，后端应返回冲突错误

### 2.2 查询登录会话快照

`GET /v1/instances/{id}/channels/weixin/login-sessions/{session_id}`

请求头：

- `X-User-Id`

响应示例：

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "session_id": "wxlogin_bbb4c7a856ce4d0eba11fe4c9bb70b60",
    "status": "waiting_qr",
    "qr_url": "",
    "qr_ascii": "▄▄▄▄ ...",
    "last_output": "...",
    "started_at": "2026-03-23T19:53:23.115+08:00",
    "expires_at": "2026-03-23T19:58:23.115+08:00",
    "finished_at": null,
    "error_message": null
  }
}
```

### 2.3 订阅会话事件

`GET /v1/instances/{id}/channels/weixin/login-sessions/{session_id}/events`

请求头：

- `X-User-Id`
- `Accept: text/event-stream`

返回类型：

- `text/event-stream`

当前已验证：

- 返回 `200`
- 首条事件为 `snapshot`

示例：

```text
event: snapshot
data: {"session_id":"wxlogin_xxx","status":"waiting_qr","qr_ascii":"▄▄▄▄ ..."}
```

后续事件类型设计：

- `snapshot`
- `status`
- `qr`
- `output`
- `finished`
- `error`

### 2.4 取消会话

`POST /v1/instances/{id}/channels/weixin/login-sessions/{session_id}/cancel`

请求头：

- `X-User-Id`

说明：

- 用于取消未完成 session
- 后端会尝试终止 sandbox 内对应进程

## 3. 状态机

当前状态定义：

- `starting`
- `waiting_qr`
- `scanned`
- `success`
- `failed`
- `timeout`
- `cancelled`
- `expired`

当前第一版最常见的状态路径：

```text
starting -> waiting_qr -> scanned -> success
starting -> waiting_qr -> expired
starting -> waiting_qr -> cancelled
starting -> failed
```

状态语义：

- `starting`
  - 已创建 session，sandbox 命令尚未产出有效登录信息
- `waiting_qr`
  - 已拿到二维码内容，可展示给前端
- `scanned`
  - 输出中已出现“扫码成功/confirmed”类证据
- `success`
  - 登录完成，且 `openclaw gateway restart` 成功
- `failed`
  - 登录命令失败，或登录后重启 gateway 失败
- `cancelled`
  - 用户主动取消
- `expired`
  - session 到期未完成

## 4. 二维码字段约定

优先顺序：

1. `qr_ascii`
2. `qr_url`

当前现实情况：

- `qr_url` 不保证稳定拿到
- `qr_url` 的语义是“扫码落地页 URL”，不是二维码图片 URL
- `qr_ascii` 是当前最可靠、最适合直接展示的返回字段

前端展示建议：

1. 若 `qr_ascii` 非空，优先使用等宽字体原样展示
2. 若 `qr_url` 非空，可额外提供“打开扫码页面”入口
3. 不要把 `qr_url` 直接当二维码图片 URL 使用
4. 若两者都为空，展示 `status=starting`

## 5. 前端接入顺序

推荐最小流程：

1. 用户点击“绑定微信”
2. 调 `POST create session`
3. 拿到 `session_id`
4. 同时发起：
   - `GET session snapshot`
   - `GET session events` SSE
5. 首屏先用 snapshot 渲染
6. 后续用 SSE 增量更新状态
7. 若 SSE 断开，退回轮询 `GET session`

推荐轮询策略：

- 仅在 SSE 建立失败或中断时轮询
- 轮询间隔可取 `2s`

## 6. 后端行为约定

### 6.1 创建 session 后的自动行为

创建 session 后，后端会自动：

1. 在 sandbox 内执行 `openclaw-weixin-login-session start`
2. 周期性执行 `openclaw-weixin-login-session status`
3. 把结构化结果写回 DB 中的 session 记录
4. 通过 SSE 向前端推送事件

补充说明：

- `status` / `cancel` 的短命令返回偶发不稳定时，`ctl` 会回退读取实例内 `state.json`
- 因此 CTL 的稳定性建立在“结构化协议 + 状态文件”上，而不是一次 process 返回必须稳定

### 6.2 登录成功后的自动行为

登录成功后，后端会自动执行：

```bash
openclaw gateway restart
```

当前约定：

- restart 成功，session 才能进入 `success`
- 若 restart 失败，session 应进入 `failed`
- 同时记录 `restart_status / restart_error`

## 7. 当前已验证能力

以下能力已在真实 sandbox 上验证通过：

- 创建 login session
- 快照接口返回 `status=waiting_qr`
- 快照接口返回完整 `qr_ascii`
- 取消接口可把 session 收敛到终态
- SSE 接口返回 `200`
- SSE 首条事件返回 `snapshot`
- sandbox 内部真实执行 `openclaw-weixin-login-session start/status/cancel`
- 可拿到真实微信二维码

已验证实例示例：

- `instance_id`: `ins-9e7f0417-b961-497c-8c8e-51e88c1b3326`
- `sandbox_id`: `1aa66b15-b338-4bae-9b6c-2f60286ea9ea`

## 8. 当前限制

当前仍有这些限制：

- `qr_url` 不稳定，不能作为唯一依赖
- 更可靠的是 `qr_ascii`
- 默认 blocker 仍只覆盖到 `waiting_qr`，没有把完整 `scanned -> success -> gateway restart` 作为日常烟测门禁
- SSE 已可用，但业务侧仍建议保留 snapshot 轮询兜底
- `cancel` 和 `status` 已做并发保护，但镜像协议的字段类型与错误码仍不够刚性

## 9. Agent 使用建议

当 Agent 需要“帮前端接微信绑定能力”时，默认按以下思路回答：

1. 不要把这件事建模成同步短命令
2. 使用 login session API
3. 前端组合使用 `snapshot + SSE`
4. 优先消费 `qr_ascii`，`qr_url` 只作为辅助入口
5. 断线时回退到轮询 `GET session`

如果 Agent 需要继续排查“为什么拿不到二维码”，下一跳应查：

- [docs/agent-guides/ctl-local-run-guide.md](ctl-local-run-guide.md)
