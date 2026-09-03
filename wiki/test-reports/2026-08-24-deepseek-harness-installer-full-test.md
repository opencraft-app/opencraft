# DeepSeek Harness 安装器 Ubuntu 全量测试报告

## 1. 测试结论

- 测试日期：2026-08-24
- 测试对象：`images/helpers/install-deepseek-harness.sh`
- 安装器 SHA256：`9a95f3519a7d716d8271ba116ea00113d96dbbe6a8560907fac3d88b2555396b`
- 测试方式：在用户提供的独占 Ubuntu 测试机上反复清理、修改实例状态并执行真实在线安装
- 用例总数：21
- 通过：20
- 失败：1
- 用例执行总耗时：230 秒，不含上传、证据采集和整机重启等待
- 总体结论：**有条件通过，发现 1 个发布阻断级健康检查缺陷。修复 TC18 并完成回归前，不建议开放真实安装。**

安装器已验证可以从最小前置环境完成全新安装，可以在网络、输入、资源和激活异常时清理或回滚，并能保留用户配置完成覆盖安装。唯一失败发生在 3080 端口已被其他 HTTP 服务占用时：安装器误把其他服务的 HTTP 200 和监听状态视为 DSH 健康，写入成功任务后 DSH 实际进入 systemd 重启循环。

## 2. 测试环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Ubuntu 24.04.4 LTS |
| 内核 | Linux 6.8.0-124-generic |
| 架构 | x86_64 |
| Node.js | v22.23.2 |
| 内存 | 约 3.7 GiB |
| 根盘 | 约 59 GiB |
| 运行用户 | `agentuser` |
| DSH | `0.1.0-rc.7` |
| 固定 pnpm | `10.33.0` |

测试机为独占、可清理环境。测试过程中真实卸载并重装编译工具，删除并重建 DSH runtime、profile、systemd unit、任务状态和固定 pnpm tooling，制造网络不可达、恶意归档、写入限制、内存限制、并发安装、激活失败、端口占用和进程崩溃。测试资产和日志未包含机器凭据。

## 3. 用例结果

| ID | 实例环境或场景 | 预期结果 | 结果 | 耗时 |
| --- | --- | --- | --- | ---: |
| TC01 | 非法任务 ID | 拒绝执行，不生成任务文件 | 通过 | 0s |
| TC02 | 非 root 用户执行 | 拒绝安装，不修改 DSH 状态 | 通过 | 0s |
| TC03 | 缺少 `agentuser` | 安全失败，不产生运行态安装 | 通过 | 3s |
| TC04 | Node.js 20 | 前置检查失败，任务进入 failed 并清理 | 通过 | 0s |
| TC05 | 无可用 pnpm，且 npm 损坏 | 固定 pnpm 无法引导时失败并清理 | 通过 | 1s |
| TC06 | 删除 build-essential、g++、make 和全部 DSH 数据 | 自动补齐工具链与固定 pnpm，完成全新安装 | 通过 | 45s |
| TC07 | 冻结安装资产缺失 | 校验失败，不下载、不激活 | 通过 | 1s |
| TC08 | 冻结资产允许 group write | 拒绝可被篡改的输入 | 通过 | 1s |
| TC09 | 所有插件下载地址不可达 | 按策略重试 5 次后失败并清理 | 通过 | 31s |
| TC10 | 插件归档包含 `../` 路径穿越 | 拒绝归档，不写出越界文件 | 通过 | 2s |
| TC11 | 进程文件写入上限为 512 KiB | 安装失败，任务进入 failed，工作目录清理 | 通过 | 33s |
| TC12 | 连续异常测试后的干净实例 | 可重新完成健康全新安装 | 通过 | 13s |
| TC13 | 已安装且存在凭据、设置、存储和 Cordis patch | 覆盖安装成功并完整保留用户数据 | 通过 | 9s |
| TC14 | root-owned 固定 pnpm 被替换为错误版本 | 自动重建 pnpm 10.33.0，覆盖安装成功 | 通过 | 11s |
| TC15 | profile 中存在未知第三方插件 | 安全失败，不覆盖 profile，不停止旧服务 | 通过 | 3s |
| TC16 | 两个安装任务并发执行 | 第二个任务在 lock 阶段失败，第一个成功 | 通过 | 10s |
| TC17 | 新版本激活时首次 systemctl restart 失败 | 恢复旧 runtime、profile、unit、启用状态和服务 | 通过 | 9s |
| TC18 | 其他 HTTP 服务占用 `127.0.0.1:3080` | 安装失败并回滚，不得误报成功 | **失败** | 18s |
| TC19 | 安装任务限制为 160 MiB 内存 | 安装失败、任务 failed、无运行态残留 | 通过 | 16s |
| TC20 | 全部破坏性测试结束 | 恢复固定版本健康安装 | 通过 | 15s |
| TC21 | 对 DSH MainPID 发送 SIGKILL | systemd 使用新 PID 自动拉起，HTTP 恢复 | 通过 | 9s |

另行执行了整机重启验证。重启前后 boot ID 不同；重启后 `deepseek-harness.service` 为 enabled、active，WebUI 正常，3080 只监听 `127.0.0.1`，当前 boot 的 DSH journal 无 error 级日志，五个插件版本均正确。

## 4. 缺陷：端口占用导致安装成功误判

### 4.1 严重级别

**P1 / 发布阻断。**

页面可能收到 `succeeded / completed / 100%`，但 DSH 并未成功运行。用户随后访问 WebUI 可能进入无关服务，或看到服务不可用；systemd 会持续重启 DSH。

### 4.2 复现条件

1. 清理现有 DSH 安装。
2. 使用其他 HTTP 服务监听 `127.0.0.1:3080`，并返回 HTTP 200。
3. 执行真实 DSH 安装。
4. 安装器返回 0，并写入成功任务。
5. 等待数秒后检查 systemd，DSH 因 `EADDRINUSE` 进入自动重启。

### 4.3 证据

- 安装器输出：`installer reported success while another process owned port 3080`。
- systemd 状态：`Active: activating (auto-restart) (Result: exit-code)`。
- DSH 主进程：`code=exited, status=1/FAILURE`。
- journal 根因：`listen EADDRINUSE: address already in use 127.0.0.1:3080`。

### 4.4 根因

当前 `validate_live_installation` 依次检查：

1. `systemctl is-active`；
2. 回环 HTTP 200；
3. `127.0.0.1:3080` 存在监听；
4. runtime 和 profile 的离线 CLI 校验。

systemd 在 DSH 完成异步初始化和端口绑定前会短暂返回 active。随后 DSH 因端口冲突退出，但 HTTP 和监听检查命中了占用端口的外部服务。检查没有验证监听 socket 属于 `deepseek-harness.service` 的 MainPID 或 cgroup，也没有校验 DSH 专属响应，因此产生成功误判。

### 4.5 修复验收条件

1. 停止旧 DSH 服务后、启动新服务前，确认 3080 没有被非目标进程监听；发现冲突时任务失败并回滚。
2. 启动后等待 DSH 专属健康信号，不接受任意 HTTP 200。
3. 校验 3080 监听进程属于 `deepseek-harness.service` 的 MainPID 或同一 systemd cgroup。
4. 在一个短稳定窗口内连续确认 service active、PID 未变化、监听归属正确和 DSH 健康响应，避免启动瞬间竞态。
5. 任一条件不满足时写入 failed、恢复旧 runtime/profile/unit/服务状态，并清理任务工作目录。
6. 将 TC18 加入本地回归测试，并在同一 Ubuntu 主机重新执行真实端口冲突测试。

## 5. 其他观察

- 缺少 `agentuser` 和非 root 场景在安装器写入 task JSON 之前失败。当前生产实时下发 wrapper 会承接准备阶段失败状态；如果未来支持直接运行安装器，需要决定是否让安装器自行发布这两类失败任务。
- 低磁盘场景使用进程文件写入上限模拟，验证了写失败后的清理；未将根文件系统真实填满，以免影响 SSH、systemd 和日志系统本身。
- 网络测试覆盖完全不可达和有限重试，未覆盖代理认证、DNS 污染、TLS 中间人和下载到一半断流。
- 单台 x86_64 Ubuntu 24.04 无法证明 arm64、Ubuntu 22.04、Debian 或其他发行版兼容性。
- 本轮直接执行安装器及其真实资产，未覆盖浏览器生成 payload、`debug/exec`、`systemd-run` wrapper 和 TAT WebUI 代理的端到端链路。
- 测试机没有同时运行 Hermes 业务负载，因此未覆盖 DSH 与 Hermes 的 CPU、内存、文件和进程竞争。

## 6. 测试后状态

- 已恢复 DSH `0.1.0-rc.7`。
- 固定 pnpm 为 `10.33.0`。
- SkillHub `0.2.13`。
- QQBot `0.1.5`。
- 微信 `0.2.5`。
- 企业微信 `0.1.5`。
- Lark `0.1.5`。
- `deepseek-harness.service` 已启用且运行中。
- WebUI 返回 DeepSeek Harness 页面。
- 3080 仅绑定 `127.0.0.1`。
- 整机重启后服务自动恢复，当前 boot 无 DSH error 级日志。
- 远端测试结果和逐项日志保留在 `/var/tmp/lightvela-dsh-full-test/`，用于后续复查；不包含登录凭据。
