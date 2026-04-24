# Frontend Shanghai Production

这个目录是 `frontend` 在上海正式环境的 deploy-facing 入口。

边界：

- source-facing 内容仍留在 `frontend/`
- 香港 Argo 通过这个目录把资源下发到上海 `frontend` namespace
- steady-state sync 只接管常驻 workload
