# .ci（持续集成）

Devcloud/BlueKing CI 定义与发布运行时脚本。

## 边界

- 本入口只约定何时加载 CI context；实现细节延后至 [CI 服务详情](../docs/context/project/services/ci.md)。
- 发布任务还要加载 `release-gitops`。
- 流水线与发布操作需要用户明确授权。

## 命令

```bash
python3 .ci/runtime/check_ci_runtime.py
python3 .ci/runtime/commands/build_release_image.py --service <service> --env <env> --tag <tag>
```

## 硬规则

- 不输出凭据值或已解密 payload。
- 未经明确的凭据任务，不得修改流水线凭据。
- 镜像构建不代表发布完成；须验证 GitOps 和 Argo 状态。
- 除非仓库明确将其作为源码跟踪，否则生成产物不得进入 Git。
