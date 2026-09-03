# CloudAgent Wisp 运行时

本目录负责 CloudAgent 外层 workspace 使用的 Wisp runtime 源码与发布打包。

规则：

- 生成 artifact 不得进入 git：`dist/`、`.tmp/`、`dist-release/`、
  `assets/bin/`, downloaded rootfs tarballs, and rootfs image files.
- 将 `config.jsonnet` 视为本地 runtime material；改提交 `config.jsonnet.example`。
- 通过以下方式构建并发布 release package：
  `cloudagent/gateway/scripts/publish_cloudagent_wisp_package.sh` or the
  combined CloudAgent artifact CI path.
- 没有关闭并恢复 session 的 live Wisp restore e2e 时，不得变更 checkpoint 或 writeback 顺序。
