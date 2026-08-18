# LightVela 国际站静态建站剩余事项

> **日期**：2026-08-18
> **分支**：`codex/site-cos-gateway`
> **范围**：后端静态建站能力、生产配置落地、TAT 凭据下发、真实机器验收，以及 Sarah 前端分支的后续联调。
> **状态口径**：本清单是剩余工作的唯一集中入口。源码配置已准备不等于生产 live 已发布；每项必须以右侧证据闭环。
> **发布边界**：本后端 MR 不包含 `frontend/**`、frontend GitOps 或 frontend Application 变更，不会自动触发 frontend 构建；但最新 `master` 已包含此前合入的建站入口代码，后端验收完成前禁止手动发布国际站 frontend。Sarah 前端分支在后端验收完成后独立发布。

## 一、已经准备好的源码配置

以下内容已经在当前分支存在，不需要重新设计或重复创建：

| 项目 | 位置 | 已具备内容 |
|---|---|---|
| 生产 COS | `argocd/services/site-gateway/sgprod/site-gateway-platform.env` | `lightvela-user-sites-1388575217` / `ap-singapore` |
| website-deployer COS | `argocd/services/workers-website-deployer/sgprod/workers-platform.env` | 正式 bucket、region、`lightvela.site` |
| site-gateway SSM manifest | `scripts/ssm_manifest.site-gateway.sgprod.yaml` | 内部 token、COS 凭据 required keys |
| CTL SSM manifest | `scripts/ssm_manifest.ctl.sgprod.yaml` | `CTL_INTERNAL_TOKEN`、`WEBSITE_INTERNAL_API_TOKEN`、COS 配置 required keys |
| website-deployer SSM manifest | `scripts/ssm_manifest.workers-website-deployer.sgprod.yaml` | 内部 token、COS、Redis required keys |
| 加密 Secret | `argocd/secrets/sgprod/*.sops.yaml` | 三份 SOPS Secret 已生成，明文不进入 Git |
| 内部 token 契约 | `argocd/services/ctl/sgprod/README.md`、`argocd/services/site-gateway/sgprod/README.md` | CTL、site-gateway、deployer 使用同一 `WEBSITE_INTERNAL_API_TOKEN` |
| 机器凭据契约 | `images/helpers/install-hermes-website-credential.sh` | 每台机器使用独立 `vik_<key_id>_<secret>`，运行时签发，不写入 SOPS |

## 二、生产发布硬门禁

按以下顺序执行，前一项没有证据不得跳到后一项：

| 状态 | 事项 | 完成证据 |
|---|---|---|
| [ ] | 受保护环境核验现有 SOPS 是否对应当前 SSM | `scan_secrets.py` 通过、KSOPS render 成功；只有 SSM 变更或 SOPS 过期/无效时才按 manifest 重新导出；不输出明文 |
| [ ] | 核对三组件内部 token 一致性 | 在受保护环境或 live Secret 内完成键级一致性检查，只输出一致/不一致 |
| [ ] | 冻结国际站 frontend 生产发布 | 后端、TLS、TAT 和真实机器 E2E 完成前，不从当前 `master` 手动发布 frontend；如必须发布其他前端需求，先用独立前端 MR 增加默认关闭的建站 feature flag |
| [ ] | 准备生产 wildcard TLS | `Secret/ctl/site-gateway-wildcard-tls` 存在，平台自动化负责续期和更新 `qcloud_cert_id`；GitOps 无证书 ID |
| [ ] | 执行 CTL migration `000028` | 生产数据库版本、5 张 website 表、配额 seed 均核验 |
| [ ] | 构建并推送后端生产镜像 | CTL、site-gateway、website-deployer 目标 tag 在生产 TCR 存在 |
| [ ] | Promote 到 `gitops` 并人工 Argo sync | Application revision、workload image、`Synced / Healthy` 均匹配目标提交 |
| [ ] | 验证生产 CLB、Ingress、TLS | 使用临时 Host/解析访问，确认 wildcard 证书和后端路由正确 |
| [ ] | 切换 `*.lightvela.site` DNS | DNS 指向生产 CLB，TTL 收敛后公网 HTTPS 仍可用 |

## 三、后端发布后的机器能力下发

| 状态 | 事项 | 完成证据 |
|---|---|---|
| [ ] | 在生产地域创建 TAT command | `ap-singapore` command 创建成功并记录 CommandId（不把凭据写入文档） |
| [ ] | CTL 为真实 CVM 逐台签发实例凭据 | 每台实例得到独立 `vik_` token；只记录实例 ID、结果和错误摘要 |
| [ ] | 通过 TAT 逐台下发凭据 | `/etc/vela/website-credential.env` 存在且权限正确，token 不出现在日志 |
| [ ] | 验证 Hermes 进程重新读取凭据 | 目标机器上的 Hermes gateway 为 active，调用 capability API 返回成功 |
| [ ] | 分发 `website-builder` Skill | Skill 文件版本与后端 API 契约一致，机器侧可发现并调用 |

## 四、真实机器与前端验收

后端和少量机器下发完成后，再做以下验收：

1. 在真实用户机器创建站点，确认返回 `site_id` 和 `https://<site_id>.lightvela.site/`。
2. 上传制品并发布，随机选一台机器确认机器文件、API operation 和 COS 内容均存在。
3. 通过公网 HTTPS 验证首页 `200`、第二次 release 生效、删除后公网 `404`。
4. 验证套餐配额、超额创建、错误重试和重复 operation 不破坏状态。
5. 对 Sarah 的 `origin/frontsandbox/site-cos-workbench-ui` 做构建和真实后端联调；前端在后端验收通过后发布。
6. 需要容量结论时，补做分阶段并发测试并记录 p50/p95/p99、错误率、CPU/内存、Redis/COS/DB 饱和度；六用户历史结果不能替代生产容量证明。

## 五、回滚与停止条件

- TLS/公网异常：先停止 DNS 扩大切换，恢复到原 CLB/DNS；不要把证书 ID 写回 GitOps。
- Argo rollout 异常：暂停后端发布，回退到发布前 GitOps revision，确认 workload 和 API 恢复。
- TAT 下发异常：停止批量下发，只保留已验证机器；撤销或重新签发受影响实例 token。
- 真实站点异常：停止前端放量，保留数据库和 COS 现场，按 operation/release/site 状态排查后再决定回滚。

## 六、当前明确不属于本 MR 的事项

- 不把 Sarah 的前端分支合并到本后端分支。
- 不把生产证书 ID、SSM 明文、COS AK/SK、内部 token 或实例 `vik_` token 写入 Git、MR、日志或本清单。
- 不把本地未跟踪的构建二进制或 HTML 产物加入提交。
