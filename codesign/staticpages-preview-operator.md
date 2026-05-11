# StaticPages Frontend Preview Operator 使用说明

这份文档记录 `master` 和 `frontsandbox/*` 分支自动预览能力：推送命中 frontend 路径后，CI 会同时构建国内版和国际版产物，并发布到 StaticPages。

## 适用场景

适合：

- 给前端改动快速生成可分享预览链接
- 同时检查国内版和国际版构建产物
- 不想手工登录 EdgeOne / Cloudflare / Tencent Cloud 控制台的日常验证

不适合：

- 正式发布
- 需要验证生产 Pages 项目的发布权限
- 需要发布带鉴权 query 的 EdgeOne 临时链接

## 核心能力

只要分支名符合：

```text
master
frontsandbox/<preview-name>
```

并且本次 push 命中 `frontend/**` 路径，CI 会自动执行：

1. `pnpm build:cn`，产出 `frontend/dist-cn`
2. `pnpm build:global`，产出 `frontend/dist-global`
3. 上传国内版到 `<preview-name>.preview.lightclaw.tech`
4. 上传国际版到 `intl-<preview-name>.preview.lightclaw.tech`

`master` 是稳定预览名，固定发布到：

```text
https://master.preview.lightclaw.tech
https://intl-master.preview.lightclaw.tech
```

示例：

```text
frontsandbox/docs-smoke-v2-20260511
```

推送后自动获得两个版本：

```text
https://docs-smoke-v2-20260511.preview.lightclaw.tech
https://intl-docs-smoke-v2-20260511.preview.lightclaw.tech
```

## 常用触发命令

`master` 预览不需要额外分支；合入或推送到 `master` 且命中 `frontend/**` 后自动更新：

```bash
git push origin HEAD:master
```

如果当前本地分支就是要预览的内容：

```bash
git push origin HEAD:frontsandbox/<preview-name>
```

如果想用一个已经存在的远端分支触发预览，可以先确认它包含 `frontend/**` 改动，再推到 `frontsandbox/*`：

```bash
git fetch origin <existing-branch>
git push origin origin/<existing-branch>:refs/heads/frontsandbox/<preview-name>
```

注意：如果 `<existing-branch>` 自身没有触发范围内的 frontend 改动，CI 可能不会跑预览流水线。

## 命名规则

- `master` 固定生成 `master` 和 `intl-master`
- `<preview-name>` 建议只使用小写字母、数字和 `-`
- 上传脚本会把 `frontsandbox/Demo_Feature` 规范化为 `demo-feature`
- 国际版固定加 `intl-` 前缀
- 如果分支名已经是 `frontsandbox/intl-demo-feature`，脚本不会生成 `intl-intl-demo-feature`

## 验证方式

推送后先等 CI 构建和上传完成，再访问两个地址：

```bash
curl -I https://<preview-name>.preview.lightclaw.tech
curl -I https://intl-<preview-name>.preview.lightclaw.tech
```

预期结果：

- 两个地址都返回 `200`
- 国内版和国际版的 `/assets/index-*.js` hash 不一定相同
- 短时间 `502` 通常表示 CI 还没上传完成，等待流水线完成后再刷新

本次已验证样例：

```text
https://docs-smoke-v2-20260511.preview.lightclaw.tech
https://intl-docs-smoke-v2-20260511.preview.lightclaw.tech
```

两个地址均返回 `200`，且分别引用不同的 `index-*.js` 产物。

## 实现边界

- 这条链路不创建 GitOps MR
- 这条链路不代表正式发布
- StaticPages 上传 token 来自 CI settings 或 `argocd/secrets/beijing-sandbox/staticpages-runtime-secrets.sops.yaml`
- 不要把 token、COS 凭据或任何可直接调用的 secret 写入文档

## 已踩坑

StaticPages 的 page index 以 revision / sha 作为 key。国内版和国际版如果共用同一个 source sha 上传，会争用同一个 metadata / storage slot。

当前实现已经规避：

- 国内版使用原始 source sha
- 国际版使用 `<source-sha>-intl`

未来如果继续增加更多区域产物，也必须为每个区域使用不同的 StaticPages revision key。
