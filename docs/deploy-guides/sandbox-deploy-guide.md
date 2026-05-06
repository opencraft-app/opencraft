# Sandbox Deploy Guide

本文件只描述 `sandbox` 的目标正式发布边界，不再把 service-local 脚本当成正式入口。

## 正式规则

- `sandbox` 的正式发布只认 `Argo CD`
- `sandbox` 的 source-facing 真源仍然是：
  - `sandbox/k8s/base`
  - `sandbox/k8s/overlays/<env>`
- `sandbox` 的 deploy-facing 真源应进入：
- `argocd/services/sandbox/<env>/`
- `argocd/apps/<env>/sandbox.yaml`

当前 live 入口：

- `argocd/services/sandbox/beijing-sandbox/`
- `argocd/apps/beijing-sandbox/sandbox.yaml`

## 保留能力

- 本地开发与 compose：
  - `sandbox/scripts/dev-compose.sh`
- 默认 pool 显式同步：
  - `sandbox/scripts/sync-default-pools.sh`
- 镜像构建：
  - `python3 images/build-image.py`

## DB Job

`sandbox` migration 现在走平台级受控入口：

- `python3 .ci/runtime/commands/run_gitops_db_job.py --service sandbox --operation migration --env <env> --revision <sha>`
- 历史 DB job 模板已退役；当前以脚本和 runbook 为准

## 不再允许的主线

- service-local 正式发布脚本已移除
- service-local `kubectl apply -k`
- 以服务目录脚本为中心的正式发布说明

## 仍保留的业务约束

- pool rollout 仍不属于 K8s 正式发布主线
- ingressproxy wildcard 与 `/health` host 兜底逻辑仍保留
- `sandbox/config/default-pools.tsv` 继续作为 pool 默认配置 source of truth
