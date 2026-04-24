# Beijing Sandbox Environment Rules

这个目录承载北京 `sandbox` 测试环境的环境级文档入口。

## Scope

- 这里描述的是 `test / beijing / sandbox` 这一套环境语义。
- 云资源主控制面在 `infra_pulumi/`。

## Documentation Rules

- 任何影响该环境运行方式、观测方式、访问入口的变更，都应该优先更新这个目录下的文档。
- 环境级结论应优先回写到这里，不要只留在聊天记录里。

## Current Child Docs

- 环境事实：
  - [README.md](README.md)
- 可观测系统：
  - [README.md](../../../observability/beijing-sandbox/README.md)
  - [AGENTS.md](../../../observability/beijing-sandbox/AGENTS.md)
