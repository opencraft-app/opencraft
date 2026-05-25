# Frontend Singapore Production

这个目录是 `frontend` 在新加坡正式环境的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `frontend/`
- 统一 Argo CD 控制面通过这个目录把资源下发到新加坡 `frontend` namespace
- steady-state sync 只接管常驻 workload
- 新加坡公网前端入口使用 `lightvela.ai`
- `tls-secrets.yaml` 内的 `XV7Zeg81` 必须在正式同步前替换为腾讯云证书 ID
