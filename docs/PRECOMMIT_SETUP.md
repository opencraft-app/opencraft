# Pre-commit 编译门禁

## 背景

防止编译不通过的代码被提交到仓库。提交时自动检查修改涉及的 Go 模块能否编译通过。

## 首次配置

```bash
pip install pre-commit   # 首次需要
make setup               # 配置 hook
```

## 检查内容

| 模块 | 编译命令 |
|------|--------|
| ctl | `go build ./cmd/api && go build ./cmd/service && go build ./cmd/bypass` |
| ai-gateway | `go build ./cmd/server` |
| sandbox | `go build ./...` |
| user/auth | `go build ./...` |
| service-gateway | `go build ./...` |

只检查本次提交中有变更的模块，未修改的模块自动跳过。

## 使用

正常提交即可，检查自动执行：

```bash
git commit -m "Fix: xxx"
```

手动运行全量检查：

```bash
make precommit-check
```

## 跳过检查（仅限紧急情况）

```bash
git commit --no-verify -m "Fix: xxx"
```

## 新增模块

编辑 `.pre-commit-config.yaml`，添加一个 `go-build-<module>` hook 即可。
