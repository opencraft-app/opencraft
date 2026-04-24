---
title: '镜像侧微信登录两段式结构化执行协议'
slug: 'sandbox-image-weixin-login-two-phase-protocol'
created: '2026-03-30T20:49:19+08:00'
status: 'ready-for-dev'
stepsCompleted: [1, 2, 3, 4]
tech_stack:
  - bash
  - python3
  - go
  - envd
  - systemd
  - openclaw CLI
  - sandbox image runtime
  - openclaw-weixin plugin
files_to_modify:
  - images/build.sh
  - images/deploy-build.sh
  - images/build-image.py
  - images/tests/test-runtime.sh
  - images/README.md
  - docs/agent-guides/sandbox-image-agent-guide.md
  - images/runtime/openclaw-weixin-login-session.sh
  - images/tests/test-weixin-login-protocol.sh
code_patterns:
  - '实例内通过 envd 执行命令，由上层服务消费结果'
  - '镜像构建主入口收敛在 images/build.sh，远端上传资产列表需要显式维护'
  - '系统级运行时命令安装在 /usr/local/bin，并同步链接到 /usr/bin'
  - 'images/helpers 下脚本主要面向人工 SSH 操作，不会自动安装进镜像'
  - '微信二维码当前由 openclaw CLI 产出，CTL 侧现有实现依赖流式文本解析'
test_patterns:
  - 'images/tests 下以 Bash 远程门禁脚本做镜像级运行时验证'
  - 'CTL 测试环境 smoke 脚本验证二维码获取链路'
---

# Tech-Spec: 镜像侧微信登录两段式结构化执行协议

**Created:** 2026-03-30T20:49:19+08:00

## Overview

### Problem Statement

当前微信登录二维码链路依赖 CTL 通过 envd 远程启动 `openclaw channels login --channel openclaw-weixin`，再解析 PTY/流式输出与补充日志来推导 `waiting_qr`、`qr_url` 与 `qr_ascii`。这种方式让 CTL 直接承担实例内交互式命令输出解释器的职责，协议脆弱，容易因为流分片、flush 时机、stdout/stderr 混杂或日志格式变化而丢失二维码证据。

### Solution

在镜像侧提供两段式结构化执行协议，由实例内部本地逻辑封装微信插件交互细节。第一段命令负责启动登录流程并生成可查询会话，第二段命令负责读取该会话的结构化状态与二维码结果。CTL 后续只需要消费稳定协议，不再直接解析原始 PTY 输出。

### Scope

**In Scope:**
- 定义镜像侧 `start/status/cancel` 微信登录执行入口
- 定义实例内会话状态文件或等价本地状态存储模型
- 定义结构化返回字段，包括 `status`、`qr_url`、`qr_ascii`、错误信息和会话标识
- 定义状态枚举、超时语义、取消语义和幂等性预期
- 定义镜像侧验收方式，证明可稳定拿到 `waiting_qr`

**Out of Scope:**
- 本轮不修改 CTL 代码接入新协议
- 本轮不修改 `openclaw-weixin` 插件实现
- 本轮不定义前端展示交互
- 本轮不覆盖扫码成功后的完整业务接入改造

## Context for Development

### Codebase Patterns

- CTL 当前微信登录逻辑位于 `ctl/pkg/instance/weixin_login.go`，通过 envd 远程执行、PTY 流回调和文本解析推进 session 状态；镜像侧新协议的目标是替换这层“解释原始输出”的职责边界。
- 现有 API 契约已经稳定暴露 `status`、`qr_url`、`qr_ascii`；镜像侧新协议需要产出等价或更强的结构化事实源，供后续 CTL 单独适配。
- 镜像构建主入口是 `images/build.sh`，其模式是直接在构建机上安装运行时、写 `/usr/local/bin` wrapper，并由 `images/deploy-build.sh` / `images/build-image.py` 显式上传构建资产；新增独立脚本文件时，上传与安装路径必须同步设计。
- `images/helpers/` 下现有 `config-weixin-channel.sh` 是给人工 SSH 操作用的外部辅助脚本，不会自动安装到镜像内部，因此不适合作为正式镜像协议入口。
- 镜像级验收集中在 `images/tests/*.sh`，以远程命令断言运行时不变量；CTL 级验收则由 `ctl/scripts/tests/smoke-openclaw-weixin-qr-testenv.py` 覆盖端到端二维码链路。
- 当前没有 `project-context.md`，本 spec 需要自包含记录镜像构建、运行时安装和测试入口约束。

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `images/build.sh` | 镜像运行时安装入口；决定新协议命令如何随镜像落盘 |
| `images/deploy-build.sh` | 手动上传远端构建资产的显式清单；新增脚本文件时需要同步 |
| `images/build-image.py` | 自动构镜编排入口；复用与校验远端构建资产上传逻辑 |
| `images/tests/test-runtime.sh` | 镜像级运行时门禁模式，定义新增协议验收脚本的风格参考 |
| `images/helpers/config-weixin-channel.sh` | 现有人工 SSH 微信登录包装脚本，可复用其预检与命令知识，但不适合作为正式协议入口 |
| `images/README.md` | 镜像分层、wrapper 和验收契约说明 |
| `docs/agent-guides/sandbox-image-agent-guide.md` | 镜像构建与运行时不变量 |
| `ctl/pkg/instance/weixin_login.go` | 当前 CTL 侧微信登录实现，定义了被替代的协议边界 |
| `docs/agent-guides/ctl-weixin-login-api-guide.md` | 当前 API 状态语义与字段契约 |
| `docs/agent-guides/ctl-weixin-followup-guide.md` | 微信链路历史问题、现有限制与演进方向 |
| `ctl/scripts/tests/smoke-openclaw-weixin-qr-testenv.py` | 测试环境二维码 smoke 验证入口 |
| `docs/developer-guide/sandbox-envd-side-effect-followup.md` | envd 视角与宿主机视角可能不一致的已知风险 |
| `images/build-manifest.json` | 当前镜像内 openclaw / weixin 版本 pin 信息 |

### Technical Decisions

- 本 spec 只定义镜像侧协议，不把 CTL 适配方案混进同一份 spec。
- 协议采用两段式而不是“一条命令等二维码”的合并式方案，以降低镜像侧命令语义复杂度，并让 CTL 后续明确承担异步编排。
- 稳定性目标不是消除插件输出波动，而是把输出解释工作收敛到实例内本地，减少跨 envd/PTy/远程流链路的脆弱性。
- 协议脚本应作为镜像内正式运行时命令安装，而不是继续复用 `images/helpers/` 的外部 SSH 辅助脚本。
- 如果协议实现依赖独立脚本文件，构镜链路必须同步支持上传与安装这些文件；否则只能继续把脚本内容内嵌在 `images/build.sh` 中，维护性较差。
- 由于 `envd` 已有“宿主机视角与 envd 进程视角 side effect 不一致”的 follow-up，镜像侧协议的状态文件应主要由同一执行上下文内的脚本读写，不把 SSH 宿主机路径可见性当成唯一事实来源。
- 新协议的首轮验收应以“稳定拿到 `waiting_qr` 且返回结构化 `qr_url/qr_ascii`”为镜像级完成标准；CTL 适配与扫码成功链路后续单开 spec。
- 新协议不仅要有人工验证脚本，还要能接入现有构镜自动化验证链路；流水线需要能直接调用专项脚本，并把“成功获取微信登录二维码”作为标准化专项验收项。
- 正式镜像命令名定为 `openclaw-weixin-login-session`，安装路径为 `/usr/local/bin/openclaw-weixin-login-session`，并同步链接到 `/usr/bin/openclaw-weixin-login-session`。
- 协议状态目录定为 `/tmp/lightclaw-weixin-login`；每个会话单独使用 `<session_id>/state.json`、`<session_id>/output.log`、`<session_id>/worker.pid` 三个文件承载事实。
- 协议第一版只要求稳定覆盖“启动并拿到首个二维码”链路，镜像侧强制支持的状态枚举为 `starting`、`waiting_qr`、`failed`、`cancelled`、`expired`；`scanned` / `success` 不纳入本轮完成标准。
- `qr_ascii` 是首要展示字段，`qr_url` 为可选辅助字段；脚本必须保证在拿到 ASCII 二维码时即使没有稳定 URL 也能返回 `waiting_qr`。
- `status` 子命令只读取状态文件，不重新触发登录命令；`start` 子命令只负责创建会话和后台 worker，不阻塞等待二维码。
- `cancel` 子命令只负责终止本会话 worker 并落 `cancelled` 状态，不负责 gateway restart 或后续业务动作。
- 为降低 CTL 后续接入复杂度，所有子命令默认输出单行 JSON 到 stdout，错误详情写入 `error` 字段，退出码仅用于区分“协议调用失败”与“协议调用成功但业务状态失败”。

### Protocol Definition

#### Runtime Command

镜像内新增命令：

`openclaw-weixin-login-session <subcommand> [options]`

支持子命令：

- `start`
- `status`
- `cancel`
- `gc`（清理过期状态目录，供运维或未来定时任务调用；不作为 CTL 首轮依赖）

#### Start Command

推荐命令签名：

```bash
openclaw-weixin-login-session start \
  --session-id <session_id> \
  --timeout-seconds <seconds> \
  --state-dir /tmp/lightclaw-weixin-login
```

行为要求：

- 若 `<session_id>` 目录不存在，则创建目录并初始化 `state.json`
- 若 `<session_id>` 已存在且状态仍为 active，返回冲突 JSON，不重复启动第二个 worker
- 在后台启动本地 worker，由 worker 执行：
  `openclaw channels login --channel openclaw-weixin`
- `start` 本身不等待二维码，只要 worker 启动成功就立刻返回
- 返回 JSON 示例：

```json
{
  "ok": true,
  "session_id": "wxls_123",
  "status": "starting",
  "state_dir": "/tmp/lightclaw-weixin-login/wxls_123",
  "state_file": "/tmp/lightclaw-weixin-login/wxls_123/state.json",
  "pid": 12345,
  "started_at": "2026-03-30T21:00:00+08:00",
  "expires_at": "2026-03-30T21:05:00+08:00"
}
```

#### Status Command

推荐命令签名：

```bash
openclaw-weixin-login-session status \
  --session-id <session_id> \
  --state-dir /tmp/lightclaw-weixin-login
```

行为要求：

- 只读取 `state.json`
- 不重新执行任何登录命令
- 若状态目录不存在，返回 `ok=false` + `error_code=session_not_found`
- 若 worker 正在运行但还未拿到二维码，返回 `status=starting`
- 若已拿到任一二维码证据，返回 `status=waiting_qr`

返回 JSON 最低字段要求：

```json
{
  "ok": true,
  "session_id": "wxls_123",
  "status": "waiting_qr",
  "qr_url": "https://...",
  "qr_ascii": "▄▄▄▄...",
  "error": "",
  "error_code": "",
  "started_at": "2026-03-30T21:00:00+08:00",
  "updated_at": "2026-03-30T21:00:13+08:00",
  "expires_at": "2026-03-30T21:05:00+08:00",
  "last_output_tail": "最近一段输出，截断后保存",
  "pid": 12345
}
```

#### Cancel Command

推荐命令签名：

```bash
openclaw-weixin-login-session cancel \
  --session-id <session_id> \
  --state-dir /tmp/lightclaw-weixin-login
```

行为要求：

- 读取 `worker.pid`
- 若进程存在，发送 `SIGTERM`，必要时在短暂等待后升级 `SIGKILL`
- 写回 `state.json` 为 `cancelled`
- 幂等：重复取消同一 session 时返回当前最终状态，不报错

#### State File Model

状态目录结构：

```text
/tmp/lightclaw-weixin-login/
└── <session_id>/
    ├── state.json
    ├── output.log
    └── worker.pid
```

`state.json` 最低字段：

- `session_id`
- `status`
- `qr_url`
- `qr_ascii`
- `error`
- `error_code`
- `started_at`
- `updated_at`
- `expires_at`
- `finished_at`
- `pid`
- `last_output_tail`

状态更新规则：

- `starting`
  worker 已启动，但尚未拿到二维码
- `waiting_qr`
  已提取到 `qr_ascii` 或 `qr_url`
- `failed`
  命令提前退出、插件加载失败、输出无法继续推进且已有明确错误
- `cancelled`
  调用 `cancel` 成功结束
- `expired`
  超过 `timeout_seconds` 仍未拿到二维码

错误码建议枚举：

- `session_not_found`
- `session_conflict`
- `plugin_missing`
- `plugin_disabled`
- `command_start_failed`
- `qr_not_found_before_exit`
- `timeout`
- `cancel_failed`

#### Worker Requirements

后台 worker 的职责：

- 预检 `openclaw` 可执行、插件已安装且启用
- 执行真实登录命令
- 将原始输出写入 `output.log`
- 在本地持续解析 `qr_ascii` / `qr_url`
- 每次状态变化后原子写入 `state.json`
- 对 `last_output_tail` 做长度裁剪，避免状态文件无限增长
- 在退出前确保把最终状态刷盘

实现约束：

- 允许本地继续使用 PTY / stdout 解析，但解析逻辑必须留在镜像内部，不再泄漏给 CTL
- 状态文件写入必须走“先写临时文件，再原子 rename”模式
- 解析逻辑应优先复用现有 `config-weixin-channel.sh` 已知的预检知识，而不是重新发明一套插件检查方式
- 若只拿到 ASCII 二维码而未拿到 URL，也必须认定为 `waiting_qr`

## Implementation Plan

### Tasks

- [ ] Task 1: 新增镜像内正式协议脚本并定义两段式命令
  - File: `images/runtime/openclaw-weixin-login-session.sh`
  - Action: 实现 `start/status/cancel/gc` 四个子命令，默认 stdout 输出单行 JSON，并将状态目录固定到 `/tmp/lightclaw-weixin-login`
  - Notes: `start` 必须后台启动 worker；`status` 只读状态文件；`cancel` 必须幂等；worker 负责执行 `openclaw channels login --channel openclaw-weixin` 并解析二维码

- [ ] Task 2: 将协议脚本纳入镜像安装链路
  - File: `images/build.sh`
  - Action: 增加运行时脚本安装逻辑，把 `images/runtime/openclaw-weixin-login-session.sh` 安装到 `/usr/local/bin/openclaw-weixin-login-session`，赋予可执行权限，并同步创建 `/usr/bin` 软链
  - Notes: 不要把脚本内容直接硬编码进 `build.sh`；应优先保留独立文件，便于版本化和后续维护

- [ ] Task 3: 补齐远端构镜资产上传，确保独立脚本能随构镜生效
  - File: `images/deploy-build.sh`
  - Action: 在手动上传入口中新增 `images/runtime/` 资产上传与远端目录准备逻辑
  - Notes: 现有上传清单只覆盖 `build.sh`、`build-manifest.json`、`remote-build-runner.sh` 和 `bin/envd`；新增脚本文件不会自动出现在远端

- [ ] Task 4: 对齐自动构镜编排的上传与 chmod 语义
  - File: `images/build-image.py`
  - Action: 更新自动远端构建资产准备逻辑，使 `images/runtime/openclaw-weixin-login-session.sh` 在自动构镜路径中也会被上传、赋权并可被 `build.sh` 安装
  - Notes: 手动入口和自动入口必须保持相同资产集合，避免“手动构镜有脚本、自动构镜没脚本”的分叉

- [ ] Task 5: 为镜像侧协议增加独立验证脚本
  - File: `images/tests/test-weixin-login-protocol.sh`
  - Action: 新增远程验证脚本，断言协议命令存在、`start` 能返回 `starting`、`status` 能在超时前推进到 `waiting_qr`，且 `qr_ascii` 或 `qr_url` 至少一个非空
  - Notes: 该脚本应沿用 `images/tests/test-runtime.sh` 和 `images/tests/test-envd-agent.sh` 的 Bash + SSHLib 风格；首轮不把“扫码成功”纳入门禁，但必须把“成功获取登录二维码”作为通过条件

- [ ] Task 6: 让镜像级门禁感知新协议入口
  - File: `images/tests/test-runtime.sh`
  - Action: 增加对 `openclaw-weixin-login-session --help` 或等价无副作用命令的存在性检查
  - Notes: `test-runtime.sh` 负责轻量门禁；真正拿二维码的耗时验证留给 `test-weixin-login-protocol.sh`

- [ ] Task 7: 更新镜像文档与约束说明
  - File: `images/README.md`
  - Action: 记录新协议命令、安装路径、状态目录、手动验证命令以及其与 `openclaw` wrapper 的关系
  - Notes: 文档中要明确它是“镜像内正式协议入口”，不是 `images/helpers/` 的人工 SSH 辅助脚本

- [ ] Task 8: 更新 sandbox 镜像开发指南
  - File: `docs/agent-guides/sandbox-image-agent-guide.md`
  - Action: 补充微信登录协议脚本的不变量、验收方式和何时需要跑 `test-weixin-login-protocol.sh`
  - Notes: 要写清楚默认镜像回归仍以 runtime suite 为主，而微信协议验证属于专项验收

- [ ] Task 9: 记录后续 CTL 适配依赖点，但不在本 spec 内实现
  - File: `images/README.md`
  - Action: 增加一段“后续 CTL 接入预期”，明确 CTL 将来应调用 `start/status/cancel`，不再直接解析 PTY 输出
  - Notes: 这里只写接口预期，不写 CTL 改造方案，避免跨 spec 耦合

- [ ] Task 10: 将微信二维码协议验证接入现有构镜自动化测试入口
  - File: `images/build-image.py`
  - Action: 为现有 `--with-verify --verify-suites ...` 体系新增微信专项 suite，例如 `weixin-login`，并在该 suite 中直接调用 `images/tests/test-weixin-login-protocol.sh`
  - Notes: 不要求把它设成默认 blocker，但必须成为标准可选验证项，确保流水线和手工构镜都能以一致方式运行“成功获取微信登录二维码”的专项测试

- [ ] Task 11: 更新镜像主说明中的 verify suite 文档
  - File: `images/README.md`
  - Action: 记录新的 `weixin-login` verify suite、推荐触发场景以及示例命令
  - Notes: 文档要明确它验证的是“成功获取微信登录二维码”，而不是完整扫码成功链路

### Acceptance Criteria

- [ ] AC 1: Given fresh sandbox 使用包含新脚本的镜像, when 在实例内执行 `openclaw-weixin-login-session start --session-id wxls_test --timeout-seconds 300`, then 命令应立即返回 `ok=true` 的 JSON，且 `status=starting`、`pid>0`、`state_file` 非空

- [ ] AC 2: Given `start` 已成功返回, when 在超时时间内轮询 `openclaw-weixin-login-session status --session-id wxls_test`, then 状态应从 `starting` 推进到 `waiting_qr`，且 `qr_ascii` 或 `qr_url` 至少一个非空

- [ ] AC 2.1: Given 镜像专项协议测试脚本被流水线或构镜验证入口调用, when 运行 `images/tests/test-weixin-login-protocol.sh`, then 脚本必须以“成功获取微信登录二维码”为通过条件并返回 0

- [ ] AC 3: Given 插件未安装或未启用, when 调用 `start`, then 返回 JSON 应包含 `ok=false`、明确 `error_code`，并且不得创建一个看似成功但永远卡住的 active session

- [ ] AC 4: Given 登录命令在真正输出二维码前异常退出, when 调用 `status`, then 应返回 `status=failed` 且 `error` 与 `last_output_tail` 能帮助定位失败层级

- [ ] AC 5: Given 同一个 `session_id` 已处于 `starting` 或 `waiting_qr`, when 再次调用 `start`, then 应返回冲突语义而不是重复拉起第二个 worker

- [ ] AC 6: Given 某个会话已进入 `starting` 或 `waiting_qr`, when 调用 `cancel`, then worker 进程应被终止且后续 `status` 返回 `cancelled`

- [ ] AC 7: Given 某个会话超过 `timeout_seconds` 仍未拿到二维码, when 轮询 `status`, then 状态应转为 `expired` 而不是永久停留在 `starting`

- [ ] AC 8: Given 协议脚本已经安装进镜像, when 执行 `env -i HOME=/root USER=root PATH=/usr/bin:/bin openclaw-weixin-login-session status --session-id missing`, then 命令应在最小 PATH 下可执行并返回结构化的 `session_not_found` 错误

- [ ] AC 9: Given 新镜像通过 `images/tests/test-runtime.sh` 和 `images/tests/test-weixin-login-protocol.sh` 验证, when 后续 CTL 适配该协议, then CTL 不再需要把 PTY 原始输出作为二维码唯一事实源

- [ ] AC 10: Given 开发者执行 `python3 images/build-image.py --with-verify --verify-suites runtime,weixin-login ...`, when 构镜验证运行到微信专项 suite, then 自动化流程会直接调用 `images/tests/test-weixin-login-protocol.sh` 并以其退出码决定该专项是否通过

## Additional Context

### Dependencies

- envd 提供稳定的实例内命令执行入口
- sandbox 镜像内存在 `openclaw` CLI 与 `openclaw-weixin` 插件
- 实例内允许写入临时状态目录或等价运行时状态存储
- `jq`、`python3`、`bash` 已在镜像构建链路中可用，可用于实现 JSON 读写与辅助解析
- `openclaw` wrapper 已负责 `NODE_OPTIONS`、`XDG_RUNTIME_DIR` 与 `DBUS_SESSION_BUS_ADDRESS` 基础环境补齐；协议脚本应复用这一运行时前提，不要重复引入新的环境分叉
- 镜像级专项验证依赖 fresh sandbox 或远端构建机具有可运行的 weixin 插件环境

### Testing Strategy

- 镜像级轻量门禁：
  使用 `images/tests/test-runtime.sh` 只验证命令存在性与最小 PATH 可执行性
- 镜像级专项协议验证：
  使用 `images/tests/test-weixin-login-protocol.sh` 在远端实例上执行真实 `start -> status -> cancel` 流程，断言能拿到首个二维码
- 构镜自动化专项验证：
  在 `images/build-image.py --with-verify --verify-suites ...` 中新增 `weixin-login` suite，直接执行 `images/tests/test-weixin-login-protocol.sh`
- 构镜回归：
  手动入口 `images/deploy-build.sh` 与自动入口 `images/build-image.py` 都必须覆盖协议脚本上传与安装
- 端到端回归：
  镜像方案落地后，再由后续 CTL spec 接入 [ctl/scripts/tests/smoke-openclaw-weixin-qr-testenv.py](/root/code/mono/ctl/scripts/tests/smoke-openclaw-weixin-qr-testenv.py) 做 API 级回归
- 建议的人工验证命令：
  `openclaw-weixin-login-session start --session-id manual_1 --timeout-seconds 300`
  `openclaw-weixin-login-session status --session-id manual_1`
  `openclaw-weixin-login-session cancel --session-id manual_1`

### Notes

- CTL 适配新协议应单独写第二份 spec，避免镜像侧协议定义和上层消费策略互相耦合。
- 当前已存在的 [images/helpers/config-weixin-channel.sh](/root/code/mono/images/helpers/config-weixin-channel.sh) 可保留为人工 SSH 工具，但不应再被视为正式协议入口。
- 若协议脚本实现中发现 ASCII 二维码解析仍不稳定，可以在镜像内部同时读取 `output.log` 与 `openclaw logs` 做本地兜底；但这种兜底必须留在镜像内部，不再暴露给 CTL。
- 如果后续决定扩展到 `scanned` / `success`，建议通过同一状态目录继续演进，而不是另起第二套命令名。
- 首轮不要把 gateway restart 并入镜像协议；否则会把“二维码获取协议”和“登录成功后的业务动作”重新耦合在一起。
