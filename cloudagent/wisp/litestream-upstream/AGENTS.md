# AGENTS.md - Litestream AI Agent 指引

Litestream 是 SQLite 灾难恢复工具：它作为后台进程运行、监控 WAL、把变更转换为不可变 LTX 文件并复制到云存储。使用 `modernc.org/sqlite`（纯 Go，不需要 CGO）。

## 开始前

1. 阅读[AI_PR_GUIDE.md](AI_PR_GUIDE.md)了解贡献要求
2. 查看[CONTRIBUTING.md](CONTRIBUTING.md)了解可接受范围（欢迎 bug fix，feature 需要讨论）
3. 审阅近期 PR 了解当前模式

## 关键规则

- **1GB lock page**：SQLite 在 0x40000000 保留 page，始终跳过。见[docs/SQLITE_INTERNALS.md](docs/SQLITE_INTERNALS.md)
- **LTX files are immutable**: Never modify after creation. See [docs/LTX_FORMAT.md](docs/LTX_FORMAT.md)
- **Single replica per database**: Each DB replicates to exactly one destination
- **Use `litestream ltx`**: Not `litestream wal` (deprecated)
- **Use `litestream reset`**: Clears corrupted local LTX state for a database. See `cmd/litestream/reset.go`
- **`auto-recover` config**: Replica option that automatically resets local state on LTX errors. Disabled by default. See `replica.go`
- **Retention enabled by default**: `Store.RetentionEnabled` is `true` by default. Disable only when cloud lifecycle policies handle cleanup. See `store.go`
- **IPC socket disabled by default**: Control socket is off by default. Enable with `socket.enabled: true` in config. See `server.go`
- **`$PID` config expansion**: Config files support `$PID` to expand to the current process ID, plus standard `$ENV_VAR` expansion. See `cmd/litestream/main.go`
- **`litestream ltx -level`**: Use `-level 0`–`9` or `-level all` to inspect specific compaction levels. See `cmd/litestream/ltx.go`
- **Return errors, don't log them**: Always return errors to callers. Never `log.Printf(err)` and continue — this silently hides failures in a disaster recovery tool. Only use DEBUG log for best-effort operations where failure doesn't affect correctness and a valid fallback exists (e.g., reading SHM mxFrame optimization hint). See [docs/PATTERNS.md](docs/PATTERNS.md#error-handling)

## 分层边界

| 层 | 文件 | 职责 |
|-------|------|----------------|
| DB | `db.go` | 数据库状态、恢复、WAL 监控、library API（`SyncStatus`、`SyncAndWait`、`EnsureExists`） |
| Replica | `replica.go` | 仅负责复制机制 |
| Storage | `**/replica_client.go` | backend 实现（包括供 v0.3.x restore 使用的 `ReplicaClientV3`） |
| IPC | `server.go` | Unix socket control API（register/unregister、/txid、pprof） |
| Leasing | `leaser.go`, `s3/leaser.go` | 通过 conditional write 获取分布式 lease |

数据库状态逻辑属于 DB layer，不属于 Replica layer。

## 快速参考

**构建：**

```bash
go build -o bin/litestream ./cmd/litestream
go test -race -v ./...
```

**代码质量：**

```bash
pre-commit run --all-files
```

## 文档

| 文档 | 何时阅读 |
|----------|--------------|
| [docs/PATTERNS.md](docs/PATTERNS.md) | 代码模式与反模式 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Deep component details |
| [docs/SQLITE_INTERNALS.md](docs/SQLITE_INTERNALS.md) | WAL format, lock page |
| [docs/LTX_FORMAT.md](docs/LTX_FORMAT.md) | Replication format |
| [docs/TESTING_GUIDE.md](docs/TESTING_GUIDE.md) | Test strategies |
| [docs/REPLICA_CLIENT_GUIDE.md](docs/REPLICA_CLIENT_GUIDE.md) | Adding storage backends |
| [docs/PROVIDER_COMPATIBILITY.md](docs/PROVIDER_COMPATIBILITY.md) | Provider-specific S3/cloud configs |

## 清单

提交变更前：

- [ ] 阅读上述相关文档
- [ ] 遵循[docs/PATTERNS.md](docs/PATTERNS.md)中的模式
- [ ] 用 race detector 测试（`go test -race`）
- [ ] 运行 `pre-commit run --all-files`
- [ ] page iteration：用 >1GB database 测试
- [ ] 在 PR 展示调查证据（见[AI_PR_GUIDE.md](AI_PR_GUIDE.md)）
