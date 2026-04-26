# EdgeOne Pages 发布流程

这份文档沉淀当前仓库 `frontend/` 发布到腾讯云 EdgeOne Pages 的实际可用流程。

相关文档：

- [EdgeOne Preview Operator 使用说明](./edgeone-preview-operator.md)
- [腾讯云 EdgeOne Preview 子账号创建记录](./tencent-cloud-edgeone-preview-account-provisioning.md)

其中：

- `edgeone-preview-operator.md`
  - 更偏“怎么用”
- `tencent-cloud-edgeone-preview-account-provisioning.md`
  - 更偏“怎么创建出来、为什么这么设计、实际做了什么”

适用范围：

- 目标项目：`frontend/`
- 目标 Pages 项目：`lightvela`
- 目标后端：北京 `lightclaw.tech`

## 当前已验证结论

- EdgeOne CLI 可直接发布静态目录到现有 Pages 项目。
- 当前已验证的项目名是 `lightvela`。
- 发布前必须先本地构建出 `frontend/dist/`。
- 预览链接如果带 `eo_token` / `eo_time`，必须完整保留；去掉参数后可能返回 `401`。
- `frontend/.edgeone/project.json` 是本地 link 状态，不应提交。

## 前置条件

1. 已安装 Node.js / pnpm。
2. 已能在本机使用 EdgeOne CLI 登录腾讯云账号。
3. 当前仓库前端依赖可正常安装。

常用检查命令：

```bash
cd frontend
pnpm --version
node --version
npx edgeone whoami
```

如果 `whoami` 提示未登录，可先执行：

```bash
npx edgeone whoami
```

CLI 会自动跳转腾讯云登录页，登录完成后本机会生成本地状态。

## 标准发布流程

### 1. 安装前端依赖

```bash
cd frontend
pnpm install
```

### 2. 指向北京后端构建

当前这条链路是为“EdgeOne 静态站 + 北京 auth 后端”准备的，所以构建时固定传：

```bash
cd frontend
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
```

构建成功后应生成：

```bash
frontend/dist/
```

### 3. 发布到现有 EdgeOne Pages 项目

```bash
cd frontend
npx edgeone pages deploy dist -n lightvela -e production
```

说明：

- `dist`：本地构建产物目录
- `-n lightvela`：现有 Pages 项目名
- `-e production`：发布到生产环境

典型成功输出会包含：

- `Project ID`
- `Deployment ID`
- `EDGEONE_DEPLOY_URL`
- 控制台 deployment 链接

## 推荐验证

### 1. 优先用正式绑定域名验证

如果项目已经绑定业务域名，优先通过正式域名访问，而不是只看 `.edgeone.cool` 预览域。

### 2. 如果使用预览链接，必须保留完整参数

EdgeOne 返回的预览链接通常形如：

```text
https://<subdomain>.edgeone.cool?eo_token=...&eo_time=...
```

不要手动删除：

- `eo_token`
- `eo_time`

否则可能直接返回：

- `401 Authorization Required`
- `X-EOP-MSG: eo_time missing`

## 本次踩坑记录

### 1. `tsc: command not found`

原因：

- 还没执行 `pnpm install`
- `node_modules/` 未就绪

处理：

```bash
cd frontend
pnpm install
```

### 2. `Deployment failed: localPath does not exist`

原因：

- `edgeone pages deploy dist ...` 启动时，`dist/` 还没构建出来
- 常见于把 build 和 deploy 并行执行

处理：

先确认：

```bash
cd frontend
ls dist
```

然后重新执行部署：

```bash
npx edgeone pages deploy dist -n lightvela -e production
```

### 3. 裸 `.edgeone.cool` 返回 `401`

原因：

- 访问时丢了 EdgeOne 返回的临时参数

处理：

- 使用完整预览链接
- 或直接改用业务绑定域名验证

## 本地状态说明

EdgeOne CLI 在本地可能写入这些状态：

- `frontend/.edgeone/project.json`
- `~/.edgeone/*`

这些都是本地登录 / 项目 link 状态，不应提交到仓库。

当前仓库已经通过 `.gitignore` 忽略：

```text
.edgeone/*
```

## 一条命令摘要

```bash
cd frontend && pnpm install && VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build && npx edgeone pages deploy dist -n lightvela -e production
```
