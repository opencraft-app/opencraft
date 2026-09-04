# 站点与环境路由领域

本领域覆盖国内/国际站、域名、locale、区域功能差异、环境 inventory 和对应 GitOps overlay。

## 稳定身份

- 国内生产：`lightvela.com`
- 国际生产：`lightvela.ai`
- 源码分支：`master`
- deploy-facing 分支：`gitops`

环境名称、集群地址、账号和当前 revision 会变化，必须从 `infra_pulumi` inventory、GitOps/Argo 和实时查询重新确认，不能从旧截图或文件名推断。

## 责任边界

| 层 | 权威 |
|---|---|
| 前端站点/locale 行为 | `frontend/src/lib/public-site-routing.ts` 与前端测试 |
| 公共 API 路由 | `service-gateway` 路由代码和测试 |
| 环境非敏感事实 | `infra_pulumi/envs/tencentcloud/<env>/inventory.yaml` |
| 部署期望 | `argocd/apps/<env>/`、`argocd/services/*/<env>/` |
| 真实运行 | Argo、集群、域名与浏览器 E2E 的现场证据 |

## 产品文档区域

`frontend/src/content/docs/` 保留 cn/global/en/id 源；生成的 zh-cn/zh-sg/en-us/zh-hant/id-id 输出不直接编辑。区域差异必须通过 parity 测试和真实路由共同证明。

相关 Journey：[双站请求路由](../journeys/dual-site-request-routing.md)。Agent 摘要：[site-environment-routing Context](../../context/domains/site-environment-routing.md)。
