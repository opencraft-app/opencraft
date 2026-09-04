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

## 官网首页展示产物

- 国内站首页由前端 React 组件与 `zh-CN` i18n 词典渲染；中文展示文案变更应保持稳定的翻译键，并验证国内站实际输出。
- 国际站首页使用 `frontend/scripts/import-international-homepage.mjs` 维护导入与本地化规则，运行时消费 `frontend/public/lightvela-intl-home/index-fragment*.html` 中已提交的多语言静态片段。
- 国际站首页文案或结构变更必须同步导入脚本、所有开放 locale 的静态片段与 `international-home-page` 聚焦测试；不得只修改默认英文片段。
- 国内站与国际站共享产品名时仍属于两套展示产物，验证时应分别启动对应区域构建或预览，不能用单站截图替代双站边界确认。

## 公开营销页区域边界

- 国内站和国际站可复用同一套公开营销页组件或静态 fragment，但必须在 `frontend/next-site/international-home-routing.ts`、`frontend/src/app/(site)/page.next.tsx` 和对应测试里显式区分站点入口、locale、CTA、文档链接和合规页脚。
- 国内站 `lightvela.com/` 默认使用国内语境的 `zh-CN` 首页内容；可以复用国际站中文版的视觉结构，但链接必须落到国内裸路径，不输出国际站 locale 前缀或海外渠道主入口。
- 国际站 `lightvela.ai/` 负责默认英文和多语言公开首页；权益文案、AI companion 语境和静态图片资源需要按 locale 同步验证，不能只改默认英文。
- Blog 当前属于国际站公开内容入口；`/blog` 和本地化 Blog 路由在国内站构建下应保持不可访问，除非另有国内站 Blog 产品需求和路由设计。
- 首页静态 fragment 的链接、图片版本参数、合规信息和客户端演示外壳属于站点路由责任面；修改后必须同步更新正式设计文档，并用静态链接检查、前端测试和本地/预览环境证明没有跨站点串链。

## Agent 人设展示区域边界

- 国内站与国际站的推荐人设注入摘要复用同一状态逻辑：以当前 Agent 真实 `SOUL.md` 的 slug 判断已注入项，优先展示文件中的真实 `Name`，并提供编辑当前文件的入口；推荐人设一旦保存编辑，即写入自定义来源标记并按自定义人设展示。
- 自定义人设的编辑、下载等操作仍服从各站点已开放的产品能力；推荐人设摘要不得据此推断或扩大区域能力。

## Agent 模型配置区域边界

- 国内站与国际站复用同一套模型配置交互，界面名称和操作提示通过前端 i18n 展示；持久化配置始终使用原始 Provider key 和模型 ID，不写入本地化名称。
- 预置 Provider 的可选模型由当前区域的产品配置目录提供，前端不使用用户 API Key 临时拉取模型列表；自定义 Provider 仍可按用户填写的端点探测或手动输入模型 ID。
- 主模型、备用模型和仅添加模型的角色来自 Hermes 配置快照。角色切换不得改变已添加 Provider 的展示顺序，也不得把目录候选误标为已添加模型。

相关 Journey：[双站请求路由](../journeys/dual-site-request-routing.md)。Agent 摘要：[site-environment-routing Context](../../context/domains/site-environment-routing.md)。
