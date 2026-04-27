# Codesign 文档入口

这份文档是 `codesign/` 的入口，目标是让**新加入的 agent** 快速理解：

- 哪些文档覆盖 EdgeOne 测试发布
- 哪些文档覆盖后端新环境创建
- 哪些文档是“操作手册”，哪些是“权限与创建记录”
- 如果流程卡在仓库外，应该联系谁

相关文档：

- [EdgeOne Preview Operator 使用说明](./edgeone-preview-operator.md)
- [腾讯云 EdgeOne Preview 子账号创建记录](./tencent-cloud-edgeone-preview-account-provisioning.md)
- [北京新后端测试环境创建记录](./beijing-backend-env-provisioning.md)

其中：

- `edgeone-preview-operator.md`
  - 更偏“怎么用”
- `tencent-cloud-edgeone-preview-account-provisioning.md`
  - 更偏“怎么创建出来、为什么这么设计、实际做了什么”
- `beijing-backend-env-provisioning.md`
  - 更偏“这次后台新环境是怎么起出来的、踩了哪些坑、哪些结论可复用”

## 文档分组

### 1. EdgeOne / 前端测试发布

- [EdgeOne Preview Operator 使用说明](./edgeone-preview-operator.md)
- [腾讯云 EdgeOne Preview 子账号创建记录](./tencent-cloud-edgeone-preview-account-provisioning.md)

### 2. 后端 / 基础设施新环境

- [北京新后端测试环境创建记录](./beijing-backend-env-provisioning.md)

这份新文档记录的是：

- 使用 `infra_pulumi` 新增北京后端测试环境
- 为什么这次先接受公网 TKE endpoint
- 为什么新增了 `manage_cam_access=false`
- 为什么测试环境不该默认照搬老环境的 EIP 规模
- 为什么 TKE addon 首次 `Upgrading` 不能直接等同于“环境失败”

## 默认范围

新 agent 默认按下面这个范围工作：

- 目标项目：`frontend/`
- 默认测试 Pages 项目：`lightvela-preview`
- 生产 Pages 项目：`lightvela`
- 目标后端：北京 `lightclaw.tech`

说明：

- **默认教程只覆盖测试项目 `lightvela-preview`**
- 生产项目 `lightvela` 不应被当作新 agent 的默认发布目标
- 如果用户没有明确要求碰生产项目，优先留在测试项目

## 新 Agent 建议阅读顺序

1. [codesign/AGENTS.md](./AGENTS.md)
2. [EdgeOne Preview Operator 使用说明](./edgeone-preview-operator.md)
3. [腾讯云 EdgeOne Preview 子账号创建记录](./tencent-cloud-edgeone-preview-account-provisioning.md)

如果只是要“把 `frontend` 发到测试环境”，通常读完前两份就够了。  
如果要继续创建子账号、调策略、理解为什么这么设计，再读 provisioning 文档。

## 当前已验证结论

- EdgeOne CLI 可直接发布静态目录到现有 Pages 项目。
- 当前默认测试项目是 `lightvela-preview`。
- 发布前必须先本地构建出 `frontend/dist/`。
- 预览链接如果带 `eo_token` / `eo_time`，必须完整保留；去掉参数后可能返回 `401`。
- `frontend/.edgeone/project.json` 是本地 link 状态，不应提交。
- 子账号 `pablozhong` 已经完成：
  - `lightvela-preview` 的 EO Pages 最小权限
  - 北京常用基础设施只读权限

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

## 标准测试发布流程

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

### 3. 发布到现有测试 Pages 项目

```bash
cd frontend
npx edgeone pages deploy dist -n lightvela-preview -e production
```

说明：

- `dist`：本地构建产物目录
- `-n lightvela-preview`：现有测试 Pages 项目名
- `-e production`：测试项目自己的 production 环境，不是线网项目

典型成功输出会包含：

- `Project ID`
- `Deployment ID`
- `EDGEONE_DEPLOY_URL`
- 控制台 deployment 链接

## 推荐验证

### 1. 优先用正式绑定域名验证

如果项目已经绑定业务域名，优先通过正式域名访问，而不是只看 `.edgeone.cool` 预览域。

### 2. 如果使用 `.edgeone.cool` 预览链接，必须保留完整参数

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
npx edgeone pages deploy dist -n lightvela-preview -e production
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
frontend/.edgeone/*
```

## 人工依赖

下面这些东西不会放进仓库：

- 子账号初始密码
- 子账号 AccessKey 明文
- Pages API Token 明文
- 带鉴权参数的临时预览链接

如果新 agent 在仓库外卡住，默认联系人：

- `Skipzhang`

适用场景：

- 需要现有受限子账号的登录材料
- 需要新建更多受限子账号
- 需要调整 EO Pages / 北京只读权限边界
- 需要确认是否允许触达生产项目

## 批量创建受限子账号脚本

如果后续需要继续批量创建“EO Pages 测试项目 only + 北京常用基础设施只读”的受限子账号，仓库里已有脚本：

- [scripts/create_edgeone_preview_subusers.py](/Users/skipzhang/code/mono2-clean/scripts/create_edgeone_preview_subusers.py)

脚本能力：

- 自动去重用户名
- 若账号不存在则创建
- 若账号已存在则补齐固定策略
- 为每个账号创建一把新的 CAM AccessKey
- 将明文结果写入本地 `chmod 600` 的 JSON 文件
- 不把密码或 AccessKey 明文打印到终端

依赖环境变量：

- `TENCENTCLOUD_SECRET_ID`
- `TENCENTCLOUD_SECRET_KEY`

示例：

```bash
TENCENTCLOUD_SECRET_ID=... \
TENCENTCLOUD_SECRET_KEY=... \
scripts/create_edgeone_preview_subusers.py jasminzhao boyuan hadezwang keriaxu walkercao
```

默认输出文件位置类似：

```text
~/.codex/tmp/edgeone-preview-subusers-<random>.json
```

## 一条命令摘要

```bash
cd frontend && pnpm install && VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build && npx edgeone pages deploy dist -n lightvela-preview -e production
```
