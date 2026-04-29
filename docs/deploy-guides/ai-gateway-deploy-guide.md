# AI Gateway Deploy Guide

本文件只描述 `ai-gateway` 的正式发布边界，不再把 service-local 脚本当成正式入口。

## 正式规则

- `ai-gateway` 正式发布只认 `Argo CD`
- source-facing 真源：
  - `ai-gateway/k8s/base`
  - `ai-gateway/k8s/overlays/<env>`
- deploy-facing 真源：
  - `argocd/services/ai-gateway/<env>/`
  - `argocd/apps/<env>/ai-gateway.yaml`

## 构建入口

```bash
python3 .ci/runtime/harness_ci/commands/build_release_image.py --service ai-gateway --env <env> --tag <tag>
```

## DB 操作面

`migration` 不再属于 service-local 正式发布路径。  
统一走平台级 DB job：

- `scripts/run_gitops_db_job.py`
- 历史 DB job 模板已退役；当前以脚本和 runbook 为准

## 运行时约束

- `gateway-backend` 仍是正式后端 workload
- `gateway-dashboard` 已独立到自己的发布链路
- `gateway-model-internal` 仍是正式内网入口

## 不再允许的主线

- service-local 正式发布脚本已移除
- `kubectl apply -k ai-gateway/k8s/overlays/<env>`
