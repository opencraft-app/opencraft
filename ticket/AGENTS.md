# Ticket Service Agent Guide

`ticket` 是 LightVela 反馈/工单系统 v1 的后端服务，参照 `subscription/` 的分层与部署惯例组织。

## 发布模型（对齐 subscription）

- source-facing:
  - `ticket/k8s/base/`
  - `ticket/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/ticket/<env>/`
  - `argocd/apps/<env>/ticket.yaml`

正式发布只认 Argo CD。

## 保留能力

- 镜像构建：
  - `python3 scripts/build-release-image.py --service ticket --env <env> --tag <tag>`
- DB migration：
  - `scripts/run_gitops_db_job.py`（物理独立库 `lightvela_ticket`）

## 约束

- `generated/` 一律不提交 Git
- migration / seed 不属于 service-local 正式发布路径
- realm 隔离：受理人只能操作本 realm 内工单，前置在 `httpapi/admin.go` middleware
- 审计：所有状态变更 SHALL 写入 `ticket_audit_log`
- 分层：`httpapi` → `service` → `store`，禁止跨层直连

## 端口

- HTTP：`:8090`（避开 subscription `:8086`）

## 相关文档

- 变更集：`frontend/openspec/{plan,proposal,spec,current_state}.md`
- 关联 MR：!1948（openspec 立项）
