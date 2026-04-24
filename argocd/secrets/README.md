# Argo CD Secrets

这个目录只放 deploy-facing 的 Secret artifact。

约束：

- 只提交 `*.sops.yaml`
- 不提交明文 `.env`
- 不提交从本地 `generated/*` 直接拷出的 secret 文件
- secret 真源默认是腾讯云 `SSM`
- `sops-age` / Git SSH 私钥 / cluster client key 这类控制面私钥不进这里

当前状态：

- 北京环境的目录骨架已建立
- 具体服务的 `*.sops.yaml` 需要由 `SSM -> GitLab CI -> export_ssm_to_sops.py` 生成

补充说明：

- `secrets/<env>/` 只放可被 Git 管理的密文 artifact
- 控制面运行时依赖的私钥型 Secret 继续走 Git 外注入
- 北京当前使用：
  - `scripts/bootstrap_argocd_sops_age.sh`
  - `argocd/runtime/beijing-sandbox/`
