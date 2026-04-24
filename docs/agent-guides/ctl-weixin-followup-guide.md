# CTL Weixin Follow-up Guide

本文件记录 `ctl` 微信登录链路在切换到镜像侧两段式结构化协议后的现状、真实踩坑与排障入口。

接口契约与前端接入说明看 [ctl-weixin-login-api-guide.md](ctl-weixin-login-api-guide.md)。
镜像侧协议与构镜约束看 [sandbox-image-agent-guide.md](sandbox-image-agent-guide.md) 和 [../../images/README.md](../../images/README.md)。

## 1. 当前实现

当前微信登录链路已经收敛为单一实现：

1. `ctl` 创建 `channel_login_sessions` 记录
2. `ctl` 通过 `envd process` 调用镜像内 `openclaw-weixin-login-session start`
3. `ctl` 定时调用 `openclaw-weixin-login-session status`
4. `ctl` 把结构化结果写回 DB，并通过 snapshot / SSE 对外暴露
5. `cancel` 走 `openclaw-weixin-login-session cancel`

关键实现位置：

- [../../ctl/pkg/instance/weixin_login.go](../../ctl/pkg/instance/weixin_login.go)
- [../../images/runtime/openclaw-weixin-login-session.sh](../../images/runtime/openclaw-weixin-login-session.sh)
- [ctl-weixin-login-api-guide.md](ctl-weixin-login-api-guide.md)

明确边界：

- `ctl` 不再把 PTY 原始输出当成二维码唯一事实源
- 镜像协议当前的事实源是实例内 `state.json`
- `ctl` 仍保留 snapshot + SSE 作为对外 API 形态

## 2. 这次已确认的坑点

### 2.1 镜像协议返回里的 `pid` 类型不稳定

真实现象：

- `cancel` 返回 JSON 时，`pid` 有时是数字
- 有时是字符串，例如 `"2503"`
- `ctl` 早期实现按 `int64` 直接反序列化，会把已经成功的取消误判成协议失败

当前处理：

- `ctl` 已兼容 `number / string / null`

后续要求：

- 镜像协议应尽量把 `pid` 固定成单一类型，避免继续把宽容解析留给调用方

### 2.2 `cancelled` 会被后台轮询覆盖回活跃状态

真实现象：

1. `cancel` 已经成功
2. 但并发中的 `status` 轮询晚一步返回旧状态
3. `ctl` 又把 session 从 `cancelled` 覆盖回 `waiting_qr`

当前处理：

- `ctl` 运行时在 `cancel` 过程中打 `closing` 标记
- 对活跃状态回刷做保护，避免取消中的 session 被重新激活

### 2.3 `envd process` 的短命令返回不能当唯一事实源

真实现象：

- 命令实际已经执行成功
- 但 `ctl` 有时拿不到可解析的 JSON 输出
- 尤其在 `status` / `cancel` 这种短命令上，偶发会出现“process 返回异常，但实例内状态文件已经更新”的情况

当前处理：

- `ctl` 在 `status` 和 `cancel` 上允许回退读取实例内
  `/tmp/lightclaw-weixin-login/<session_id>/state.json`

结论：

- 当前稳定性建立在“结构化命令 + 状态文件”上
- 不是建立在“一次 process 调用必须稳定返回完整 JSON”上

### 2.4 pool 已切镜像，不代表 fresh 实例马上全部命中新协议

真实现象：

- `pools.base_image` 已经切到新镜像
- 但候选池里旧库存实例还没全部回填成 `CLEAN`
- 这时 CTL 端到端烟测可能失败在 `create-instance`，而不是失败在微信协议本身

排障时不要直接把这类失败归因到微信登录逻辑。

先查：

1. 候选 pool 的 `base_image`
2. 候选 pool 当前 `CLEAN` 库存
3. 是否命中了不在 fallback 候选列表里的 pool

### 2.5 `waiting_qr` 通过不等于完整扫码成功链路已闭环

当前真正稳定验收到的是：

- `create session`
- `status -> waiting_qr`
- `qr_ascii / qr_url` 至少一个非空
- `cancel`

尚未作为默认 blocker 的是：

- `scanned`
- `success`
- `gateway restart`

所以排障时要先分清：

- “拿不到二维码”
- 和
- “扫码成功后的后续状态没闭环”

这是两个不同层级的问题。

## 3. 当前推荐排障顺序

### Step 1: 先看 snapshot

重点字段：

- `status`
- `qr_ascii`
- `qr_url`
- `error_message`
- `last_output`

### Step 2: 再区分失败层级

#### A. `create-instance` 就失败

优先看 pool 镜像和库存，不要先怀疑微信协议。

#### B. session 长时间停在 `starting`

优先检查：

1. 实例内 `openclaw-weixin-login-session status --session-id <id>`
2. `/tmp/lightclaw-weixin-login/<session_id>/state.json`
3. `/tmp/lightclaw-weixin-login/<session_id>/output.log`

如果状态文件已经是 `waiting_qr`，但 API 还停在 `starting`，再回头看 `ctl` 协议消费逻辑。

#### C. session 很快进入 `failed`

优先看：

1. `error_message`
2. `last_output`
3. `output.log`

当前最常见原因仍然是：

- 插件加载失败
- OpenClaw 运行时问题
- gateway / 配置问题

不是 `ctl` API 自身路由问题。

#### D. `cancel` 报错

优先区分：

1. 镜像协议真的没有取消成功
2. 还是 `ctl` 没拿到稳定的 process 返回

如果实例内 `state.json` 已经收敛到终态，而 API 报错，优先怀疑协议消费层，而不是先改镜像脚本。

## 4. 当前自动化验证入口

镜像侧：

- `bash images/tests/test-runtime.sh root@<host>`
- `bash images/tests/test-weixin-login-protocol.sh root@<host>`
- `python3 images/build-image.py --with-verify --verify-suites runtime,weixin-login ...`

CTL 侧：

- `python3 ctl/scripts/tests/smoke-openclaw-weixin-qr-testenv.py --env beijing-sandbox`
- `python3 ctl/scripts/tests/smoke_local_api.py --verify-weixin-login`
- `python3 ctl/scripts/tests/regression_local_api.py --verify-weixin-login`

推荐顺序：

1. 先过镜像专项验证
2. 再 rollout pool 镜像
3. 再跑 CTL 端到端 smoke

## 5. 文档边界

本文件保留“当前实现 + 坑点 + 排障顺序”。

以下内容不要继续写回本文件：

- 旧的 PTY 流式代理修复细节
- “默认镜像不预装 weixin”这类已经过时的基线结论
- 已经废弃的 `ctl` 侧 CLI 输出提取方案

如果未来再做协议演进或技术债收敛，统一记录到
[../developer-guide/ctl-weixin-login-tech-debt.md](../developer-guide/ctl-weixin-login-tech-debt.md)。
