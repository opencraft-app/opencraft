# Frontend DS Agent Guide

- `frontend-ds` 的目标正式发布模型是 `Argo CD`
- source-facing 真源：
  - `frontend-ds/k8s/base`
  - `frontend-ds/k8s/overlays/shprod`
- `shprod` deploy-facing skeleton 已建立：
  - `argocd/services/frontend-ds/shprod/`
  - `argocd/apps/shprod/frontend-ds.yaml`
- 镜像构建统一走：
  - `python3 scripts/build-release-image.py --service frontend-ds --env shprod --tag <tag>`
