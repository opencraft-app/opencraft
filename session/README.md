# Session

`session` 的正式发布模型已经改成：

- source-facing:
  - `session/k8s/base/`
  - `session/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/session/<env>/`
  - `argocd/apps/<env>/session.yaml`

正式发布只认 `Argo CD`。  
服务目录不再承担正式 `apply / release`。
