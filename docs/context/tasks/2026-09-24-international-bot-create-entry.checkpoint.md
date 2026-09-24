## stage
MR !4621 已合入最新 `master` 解决生成清单冲突，本地回归通过；下一步提交最终清单并核对远端 CI。

## verified
- CI 日志的阻塞点是 OpenCraft vendored manifest drift；frontend 检查已通过。
- `frontend/src` 真源提交为 `a836219d9d481adf7236d486054c2c48a2a4235d`。
- 官方同步只改变 `UPSTREAM.json.sourceRevision`；130 个生成文件的只读一致性检查通过。
- 合并提交 `e1254d3c9` 后再次同步，清单来源更新为该提交；聚焦测试 54/54、`pnpm check` 和国际站构建通过。

## unverified
- 新提交后的远端 CI 最终状态。

## discard
- 翻译告警和 MDX 迁移提示不是本次 CI 的终止原因。

## restore
- 工作分支：`codex/show-global-bot-create`，MR !4621。
- 当前真源合并提交：`e1254d3c9`，目标 `origin/master@dac769cce`。
- 生成源：`frontend/src`；生成目标：`opencraft/plugins/lightvela-hermes/src/upstream/mono2/`。

## next_action
提交本次同步生成物并推送，然后核对 MR 源 SHA 与 CI 即时状态。
