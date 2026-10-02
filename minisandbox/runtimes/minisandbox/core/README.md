# Minisandbox

Minisandbox 是一个基于 PVM 的 Linux application sandbox。它运行真实的
Linux guest，从 warm checkpoint 创建 COW clone，并通过少量有界设备向
guest 提供网络、控制和可写块存储。

当前仓库已经形成一个可运行、经过故障与长时间测试的 vertical slice；它
不是 LibOS，也还不是完整的生产托管服务。

```text
Debian / Python / Node / Hermes
            |
      PVM Linux 6.7.12
            |
  shared base EROFS/PMEM/DAX
  + shared application EROFS
  + clone-private ext4 upper
            |
  PVM COW RAM + bounded devices
            |
  SQLite MetaStore + COS emulator
```

## 已经实现

### PVM Linux sandbox

- 运行真实 Linux 6.7.12，不要求修改普通 Linux 应用二进制。
- Debian/glibc、bash、Python、Node、GCC 和 curl 等用户态工具已经运行验证。
- 自有 PID 1/init 负责挂载、进程组托管、信号转发和僵尸进程回收。
- `fork`、`execve`、`waitpid`、pipe、eventfd、epoll、futex、signal、
  `mmap` 和 `mprotect` 等 syscall 由 guest Linux 内核处理，不转发给 host。
- guest Linux 基线、配置、补丁及其上游 commit 均在仓库中固定记录。

参见 [`guest/pvm-linux/README.md`](guest/pvm-linux/README.md)。

### Warm checkpoint 与 COW clone

- Python 和 Hermes 可以运行到 warm point 后冻结为内存模板。
- 模板 RAM 使用 sealed memfd 和 `MAP_PRIVATE`；clone 共享未修改页面并拥有
  独立的私有脏页。
- 每个 clone 获得独立的 vCPU、设备、mailbox、capability generation 和
  Linux 状态。
- checkpoint ioctl 是 one-shot；从模板恢复的 clone 不能再次执行该
  checkpoint。
- Linux free-page reporting 可以把不再使用的 clone-private 页面退回模板
  backing。
- 在当前开发主机上，历史样本的 restore-to-Python 时间约为 0.9--1.2 ms，
  初始私有页约为 528--536 KiB；这些数字不是跨机器性能承诺。

### 三层文件系统

```text
shared base EROFS/PMEM/DAX
        +
shared application-version EROFS
        +
clone-private ext4 writable upper
```

- base 和 application 页面通过只读 PMEM/DAX 映射与 host page cache 跨
  clone 共享。
- 本地文件后端支持 reflink，并在不可用时退化为 sparse extent copy。
- 数据库后端不为每个 clone 创建 block image、loop 或 NBD 设备；PVM
  virtio-blk 直接调用 typed SQLite block backend。
- checkpoint 会 seal 当前 delta layer；clone 通过 O(1) 元数据 snapshot/fork
  获得独立 volume 和 writer epoch。
- clone destroy 会原子 fence writer、释放 live root 并 retire volume。

参见 [`block-service/README.md`](block-service/README.md) 和
[`../storage/README.md`](../storage/README.md)。

### 网络

- `127.0.0.0/8` 由 guest 内真实 Linux TCP loopback 处理。
- 外部 TCP 和受限 UDP DNS 通过固定 mailbox 与 Rust broker 提供。
- 不需要 TAP/TUN、network namespace、NAT、iptables 或 virtio-net。
- host 可以把一个 accepted stream capability 注入指定 guest listener。
- 已实现连接配额、背压、公平轮询、half-close、RST、超时及 clone teardown
  fencing。
- 当前仍是每 clone 一个 socket worker，而不是每宿主核一个共享 reactor。

参见 [`socket-service/README.md`](socket-service/README.md)。

### Sandbox 控制与 Hermes

- 主程序提供 `init` 子命令，同一实现也可以编译为独立的
  `minisandbox-init` guest 产物。
- host control API 支持命令执行、PTY、限定文件读写、deadline 和取消。
- 固定版本的 Hermes application EROFS 已包含 hash-based `.pyc`。
- 已验证 Hermes CLI、warm interpreter、warm daemon、deterministic chat E2E
  和通过 host ingress FD 访问 guest loopback gateway。
- Hermes profile 在 clone 内使用非特权用户运行；credential 不进入 warm
  template。

参见 [`rootfs/README.md`](rootfs/README.md)。

## 存储实现与验证

当前存储路径是：

```text
guest /dev/vda (warm system disk)
guest /dev/vdb (clone-time persistent sparse ext3 ActorBlockVolume)
    -> /workspace
    -> bounded single-queue virtio-blk device
    -> typed block backend
    -> SQLite MetaStore/hot data
    -> Tencent COS consistency emulator cold tier
```

这条路径不经过 NBD。NBD 仅作为普通 Linux block-layer 的隔离验证适配器。

已经实现并测试：

- 4 KiB--512 KiB aligned transaction、FLUSH、FUA 和 versioned DISCARD
  存储语义；
- writer epoch fencing、稳定 `op_id` 去重和 uncertain-result recovery；
- sharded delta heads、sealed layer snapshot/fork 和 block-level COW；
- immutable extent pack、authenticated cold read、安全 hot eviction 和
  exact-key GC；
- SQLite bounded single-owner actor；同一 PVM template 的 clone 共享一个
  writer connection，过载表现为排队而不是 `SQLITE_BUSY`/virtio `IOERR`；
- 可脚本化 `NotFound`、stale、corrupt、timeout-before/after-apply 的腾讯 COS
  弱一致性 emulator；
- TLA+ finite-state models、mutation counterexamples、SIGKILL fault injection、
  Porcupine history checking、fio、ext4/XFS 和部分 xfstests 验证。

最新真实 PVM Linux/ext4 correctness soak 完成：

```text
17 waves
544 real PVM clones
8 x 32-way concurrent waves
2,176 guest worker processes
no SQLITE_BUSY or database-lock error
no virtio IOERR or ext4 journal abort
no timeout, panic, data mismatch, or cross-clone leak
```

完整记录见
[`benchmarks/pvm-linux-sqlite-soak/VERIFICATION.md`](benchmarks/pvm-linux-sqlite-soak/VERIFICATION.md)。

## 当前边界

以下内容尚未完成，不能作为当前产品能力宣称：

- 没有接入真实 FoundationDB C client/cluster；`fdb-adapter` 当前只有 tuple
  keyspace、sharded delta 和 versionstamp 编码。
- 没有接入真实腾讯云 COS production adapter；当前 cold tier 是一致性与
  故障 emulator。
- 没有独立 storage daemon 或多个宿主进程共享同一 SQLite 文件的协调协议。
- retired volume tombstone 和空 delta layer 当前不会最终回收，属于无界控制面
  元数据 retention；live guest block data 会正确归零。
- PVM virtio-blk 当前是单队列、同步单请求执行；尚无异步 multiqueue。持久卷
  直接使用稀疏 ext3；discard/fstrim 向 Block Engine 下传 DISCARD 以降低 live
  block 占用。
- warm template 当前是进程内对象，没有跨宿主迁移和通用落盘 snapshot 格式。
- 还没有完整的多租户控制面、身份与密钥系统、调度、计费、host-wide quota
  和生产安全审计。
- Hermes 是经过验证的应用 profile/example，不是完整托管 SaaS。

当前最准确的项目定位是：

> 一个能运行真实 Linux、从 warm checkpoint 快速创建 COW clone、提供网络
> 和独立可写磁盘，并对关键存储协议进行了模型与故障验证的 PVM application
> sandbox 原型。

下一阶段的核心工作是接入生产 MetaStore/COS adapter，解决 volume 生命周期
元数据回收，并补齐服务控制面与运维边界。

## 构建与入口

构建 PVM Linux guest：

```sh
cargo xtask pvm-linux prepare
cargo xtask pvm-linux configure
cargo xtask pvm-linux build
cargo xtask pvm-linux initramfs
```

构建 host CLI 和独立 guest init：

```sh
cargo build --locked --release -p minisandbox-cli -p minisandbox-init --bins
target/release/minisandbox init --help
target/release/minisandbox-init --help
```

运行 storage workspace 测试：

```sh
cargo test --locked --workspace --manifest-path ../storage/Cargo.toml
```

运行真实 PVM SQLite/ext4 admission：

```sh
MSBENCH_GUEST_STRESS=1 \
MSBENCH_SETTLE_BASELINE=1 \
MSBENCH_CLONES_PER_WAVE=2 \
MSBENCH_DURATION_SECONDS=0 \
./benchmarks/pvm-linux-sqlite-soak/run-soak.sh
```
