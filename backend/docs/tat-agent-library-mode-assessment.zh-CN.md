# TAT Agent 嵌入 Go 的 Library 模式评估

> 决策更新（2026-07-31）：用户已选择单进程、单文件交付。本文的方案比较保留为
> 决策记录，但“保留子进程作为默认/回退”的原建议已失效。当前正式实现是
> macOS ARM64 one-shot staticlib + CGO，只发布 `chatserver-computer`。

## 结论

可以实现，但要区分两个目标：

1. **单实例、one-shot library**：一台 Computer 的 Go 进程只启动一次 TAT，
   TAT 与 Go 同生共死。这条路径可行，改造量中等，适合先做 macOS ARM64 Canary。
2. **可在同一 Go 进程内反复 stop/start 的完整 library**：可以实现，但不是简单
   增加一个编译目标。需要把当前大量进程级 singleton、后台任务和退出语义改成
   实例级生命周期，属于核心重构。

当前正式选择是 one-shot library：删除旧进程 runner、fallback、Rust 主程序、
daemon、安装脚本和 self-update。是否实现同进程热重启留到后续，不影响 v1。

## 当前代码为什么假设独占进程

当前入口会：

- 修改整个进程的 current working directory；
- 初始化全局 log4rs；
- 安装全局 panic hook，panic 后直接 `process::exit`；
- 执行 daemonize；
- 从全局 CLI 参数解析注册、注销和执行命令，完成后直接退出；
- 创建并独占一个 Tokio multi-thread runtime；
- 启动 Executor、TSSH、定时任务和永久 WebSocket 重连循环。

进程级假设还存在于业务模块：

- `config.dat` 通过静态 `OnceCell` 只加载一次；
- Executor、EventBus、TSSH、URL、System、Vela connection map 等使用静态状态；
- leak checker、ForceRestart、self-update 和部分 CLI 路径可以结束整个进程；
- 大量 `tokio::spawn` 与独立线程没有统一 cancellation、join 和 shutdown；
- 没有对外 C ABI，也没有 library crate target。

因此，直接把 crate 改成 `staticlib` 虽然可能编译，但不能安全嵌入 Go。

## 有利条件

- `main` 本身很薄，核心协议、WebSocket、任务、PTY 和文件能力已经模块化；
- Executor、TSSH、ontime 初始化后都会返回，唯一主常驻 future 是 WebSocket
  重连循环，容易被统一的 `AgentCore::run(cancel)` 包住；
- macOS 已禁用下载式 self-update，首版不需要解决二进制自替换；
- macOS 使用 Security.framework/native-tls，没有额外 C++ runtime；
- 产品本身只需要每个 Computer 一个 TAT 实例，首版不要求多实例；
- 当前 Rust 子进程常驻 RSS 约 11 MiB，规模不大，适合在 Canary 中直接比较
  embedded 前后的真实收益。

## 推荐的内部结构

先把 binary 与 library 共用的核心提出来：

```text
src/
├── lib.rs
├── main.rs
├── core/
│   ├── config.rs
│   ├── lifecycle.rs
│   └── runtime.rs
├── ffi.rs
├── executor/
├── network/
├── ontime/
└── tssh/
```

核心接口建议先保持 Rust 原生：

```rust
pub struct AgentConfig {
    pub state_dir: PathBuf,
    pub computer_home: PathBuf,
    pub console_log: bool,
    pub self_update: bool,
}

pub enum ExitReason {
    Stopped,
    RestartRequested,
    Fatal(String),
}

pub struct AgentCore { /* runtime-owned state */ }

impl AgentCore {
    pub fn new(config: AgentConfig) -> Result<Self>;
    pub fn start(&mut self) -> Result<()>;
    pub fn stop(&self);
    pub fn join(&mut self, timeout: Duration) -> Result<ExitReason>;
}
```

不再保留 `main.rs`。Go Computer 是唯一进程入口，Rust 只提供 library。

## 最小 C ABI

首版 ABI 应只传递普通字节和 opaque handle，不保存 Go pointer，也不让 panic
穿过 FFI：

```c
typedef struct tat_agent_handle tat_agent_handle;

tat_agent_handle *tat_agent_create(
    const uint8_t *config_json,
    size_t config_len,
    tat_error *error);

int32_t tat_agent_start(tat_agent_handle *handle, tat_error *error);
int32_t tat_agent_stop(
    tat_agent_handle *handle,
    uint64_t timeout_ms,
    tat_error *error);
int32_t tat_agent_wait(
    tat_agent_handle *handle,
    uint64_t timeout_ms,
    tat_exit_reason *reason,
    tat_error *error);
void tat_agent_destroy(tat_agent_handle *handle);
```

实现要求：

- 每个导出函数使用 `catch_unwind`，禁止 Rust unwind 跨越 C ABI；
- `start` 创建 Rust-owned OS thread，该线程独占 Tokio runtime；
- `stop` 只发送 cancellation，并等待任务、PTY 和子进程按策略退出；
- `destroy` 只有在 join 完成后才允许释放；
- 首版不做 Rust → Go 日志回调，继续写受限日志文件；
- 状态和错误由 Go 轮询/读取，避免复杂的跨语言 callback 生命周期；
- macOS 优先使用 `staticlib`，避免额外 dylib 搜索路径、签名和发布问题。

## 必须修改的语义

### 1. 路径

不能再调用 `set_current_dir`。以下路径全部由 `AgentConfig.state_dir` 派生：

- `config.dat`
- `log/`
- 临时任务和传输文件
- 更新目录
- PID/lock 状态

远端任务自身的 working directory 仍按 TAT 请求执行，不受此限制。

### 2. 退出与重启

所有 `process::exit` 必须在 core 路径消失：

- `ForceRestart` 转成 `ExitReason::RestartRequested`；
- leak checker 转成错误/重启请求；
- panic 转成 `ExitReason::Fatal`；
- register/unregister/execute 的退出码只保留在 binary CLI adapter；
- macOS embedded 模式永久关闭 Rust self-update，由 Go/平台升级整个 Computer。

### 3. 取消与清理

所有长期任务使用同一个 cancellation root，并记录 JoinHandle：

- Notify WebSocket 和 Forward WebSocket；
- ontime 检查线程/任务；
- EventBus subscriber；
- Executor 中正在执行的命令；
- PTY、proxy、file session；
- 延迟清理和 task result uploader。

停止时先拒绝新任务，再关闭 WebSocket，最后按超时终止子进程。

### 4. 全局状态

one-shot 首版可以暂时保留只读 machine info、HTTP client 等真正进程级缓存。
以下状态最终必须进入 `AgentCore`：

- config 与 registration；
- Executor running/cache；
- EventBus；
- TSSH sessions、sequence、rate limiter；
- Vela connections；
- URL/region 选择状态；
- restart guard。

否则只能支持“一次启动直到 Go 进程退出”，不能承诺同进程热重启。

## Go 接入方式

实际结构为：

```text
internal/computerhost/
├── embedded.go
└── tatffi/
    ├── runtime_darwin_arm64.go
    ├── runtime_unsupported.go
    └── types.go

computer/tat-agent/
├── include/tat_agent.h
└── target/release/libtat_agent.a
```

构建约束：

- `CGO_ENABLED=1`；
- Rust 与 Go 都固定 macOS ARM64 target；
- 构建清单记录 Rust commit、Cargo.lock hash、staticlib hash 和最终 Go binary hash；
- Go 侧只看到 `Runner.Run(ctx)`，不暴露裸 FFI handle。

注册建议复用同一 core 的普通 Rust async 方法，再提供独立 FFI。不要让 Go 拼装或
解析 `config.dat`，也不要继续通过 shell 调用注册 CLI。

## 三种方案比较

| 方案 | 优点 | 代价 | 建议 |
|---|---|---|---|
| 旧 Rust 子进程 | 故障隔离最好；可独立重启；Go 保持纯 Go | 多一个进程和文件 | 已删除 |
| one-shot staticlib | 一个 Computer 进程；单一生命周期 | Rust 故障带走 Go；不能同进程热重启；引入 cgo | v1 正式方案 |
| 完整可重启 staticlib | 单进程且能由 Go 监管重启 | 要实例化大部分全局状态和 shutdown | 仅在 Canary 证明收益后做 |

如果目标只是“单文件交付”，还有一个风险更低的方案：Go 内嵌签名后的 Rust
executable，首次运行原子释放并校验 SHA-256，仍以子进程执行。它不能减少进程数，
但保留故障隔离，也不需要 FFI 重构。

## 验收门禁

embedded Canary 至少需要：

1. 注册、重连、TAT command、PTY、Vela tunnel 与当前 wire 完全兼容；
2. Go context cancel 后所有 Rust thread、WebSocket、PTY 和子进程都退出；
3. 远端 ForceRestart 不结束 Go 进程，只返回可诊断原因；
4. Rust panic 注入不能 unwind 进 Go，也不能静默挂死；
5. active PTY/command 中 stop 有确定的宽限和强杀语义；
6. 配置、日志和临时文件仍位于指定 0700 状态目录；
7. Go race、Rust tests、ASan/泄漏检查和 24 小时重连 soak 通过；
8. 与旧 Canary 的 wire 结果做差分验收；
9. 最终发布目录不存在 Rust 主程序或进程 fallback。

## 推荐实施顺序

### P0：共享 Core，不改变部署

- 增加 `lib.rs` 和 `AgentCore`；
- `main.rs` 改为 core adapter；
- 路径显式化；
- 把退出语义改为 `ExitReason`；
- 现有 binary 行为和故障验收必须保持不变。

### P1：macOS one-shot embedded Canary

- 增加 staticlib 和最小 C ABI；
- 增加 Go `tatffi` 与 build tag；
- 只允许一个实例、一次 start；
- ForceRestart 时让 Go Computer 有序退出；
- 先完成新二进制验收，再一次性替换旧 Canary。

### P2：仅在收益明确时做热重启

- 实例化 EventBus、Executor、TSSH、config 和所有 connection state；
- 完成 cancellation/join；
- 支持同一 Go 进程内 `start → stop → start`；
- 再评估 Linux/Windows。

## 最终建议

**正式采用 macOS ARM64 one-shot staticlib + CGO。只发布一个
`chatserver-computer`，不保留独立 TAT 进程或 fallback。**

故障隔离从“子进程级”变为“整个 Computer 进程级”；由外部部署系统重启整个
Computer。该取舍换来真正的单进程、单文件交付，且无需改腾讯 TAT wire 协议。
