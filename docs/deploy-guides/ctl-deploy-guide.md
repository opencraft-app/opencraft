# CTL Deploy Guide

本文件只描述 `ctl` 的目标正式发布模型边界，不再把 service-local 脚本当成正式入口。

## 正式规则

- `ctl` 的正式发布只认 `Argo CD`
- `ctl` 服务目录不再承担正式 `apply / release`
- `ctl` 仍保留：
  - `k8s/base`
  - `k8s/overlays/<env>`
  - Docker build 输入
  - 本地开发配置渲染

## 构建入口

统一走：

```bash
python3 .ci/runtime/harness_ci/commands/build_release_image.py --service ctl --env <env> --tag <tag>
```

## 正式 deploy-facing 真源

- `argocd/services/ctl/<env>/`
- `argocd/apps/<env>/ctl.yaml`

当前 live 入口：

- `argocd/services/ctl/beijing-sandbox/`
- `argocd/apps/beijing-sandbox/ctl.yaml`

## 配置边界

- `platform.env` 由 `infra_pulumi` 回写
- 服务目录不再消费 `platform.env` 去做正式 apply
- `generated/` 仅允许存在于本地开发辅助链路

## DB Job

`ctl` migration 现在走平台级受控入口：

- `python3 .ci/runtime/commands/run_gitops_db_job.py --service ctl --operation migration --env <env> --revision <sha>`
- 历史 DB job 模板已退役；当前以脚本和 runbook 为准

## 异步链路与 DB 约束

`ctl` 仍然保持：

- `api`
- `service`
- `bypass`

三类 workload 语义不变。
后续如纳入正式 GitOps 主线，也必须按同样三类进程建模。

## 不再允许的主线

- service-local 正式发布脚本已移除
- 服务目录内 `kubectl apply -k`
- 任何以 `ctl` 服务目录脚本为中心的正式发布说明
