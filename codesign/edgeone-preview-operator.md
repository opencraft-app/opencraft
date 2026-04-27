# EdgeOne Preview Operator 使用说明

这份文档描述测试专用账号 `pablozhong` 的用途、权限边界、创建 API Token 的方法，以及如何把 `frontend/` 发布到测试用 EdgeOne Pages 项目 `lightvela-preview`。

创建过程、权限分析与 CAM 策略详见：

- [腾讯云 EdgeOne Preview 子账号创建记录](./tencent-cloud-edgeone-preview-account-provisioning.md)

## 账号信息

- 子账号：`pablozhong`
- UIN：`100048437661`
- 目标测试项目：`lightvela-preview`
- ProjectId：`pages-t27yodey8xhp`

当前已经绑定的权限分两块：

1. `eo-pages-lightvela-preview-only-20260427`
   - 允许创建 EdgeOne Pages API Token
   - 允许上传构建产物
   - 允许查看/修改 `lightvela-preview`

2. `beijing-common-readonly-20260427-v2`
   - 允许只读查看北京常用基础设施
   - 便于测试环境排障

## 这份文档适合谁

适合：

- 需要把 `frontend` 发到 `lightvela-preview` 的新 agent
- 需要用现有测试子账号做 EO Pages 测试发布的协作型 agent
- 需要查询北京测试环境现象、但不需要改资源的排障 agent

不适合：

- 默认拿来发布生产 Pages 项目
- 默认拿来做基础设施变更

## 权限边界

`pablozhong` 的设计目标是：

- 可以部署测试用 EdgeOne Pages 项目
- 可以查看北京测试环境常用基础设施
- 不应具备生产项目发布权限

因此它可以做：

- 登录腾讯云控制台
- 进入 EdgeOne Pages
- 给 `lightvela-preview` 创建 API Token
- 把 `frontend/dist` 发布到 `lightvela-preview`
- 查询北京常用基础设施（如 TKE / CLB / CLS / Redis / CynosDB / TCR / VPC / CVM / Monitor）

它不应该做：

- 发布生产 Pages 项目 `lightvela`
- 修改北京基础设施

补充说明：

- 当前策略已经额外放开 `teo:CreatePagesResources`
- 所以它**具备创建新 Pages 项目的能力**
- 但这不改变本教程的默认边界：
  - 默认仍只用于 `lightvela-preview`
  - 若要新建其他项目，先与 `Skipzhang` 确认

## 仓库外依赖

这份教程依赖几项仓库外材料：

- `pablozhong` 的控制台登录信息
- `pablozhong` 的 CAM AccessKey
- 或者由 `pablozhong` 创建出来的 Pages API Token

这些材料不写进仓库。  
如果需要获取，默认联系人：

- `Skipzhang`

## 首次登录

首次登录使用平台分配的初始密码，登录后按提示修改密码。

登录入口：

- 腾讯云控制台：<https://console.cloud.tencent.com/>

## 创建 EdgeOne Pages API Token

1. 使用 `pablozhong` 登录腾讯云控制台。
2. 进入 EdgeOne Pages 控制台。
3. 定位到 Pages API Token 页面。
4. 创建一个新 token。
5. 填写说明，例如：
   - `lightvela-preview-ci`
6. 设置合理的过期时间。
7. 保存 token。

注意：

- Token 只会在创建时完整展示一次。
- 要放到 CI 或本地安全存储，不要提交进仓库。
- 首次登录 `pablozhong` 时，腾讯云控制台可能要求：
  - 先改密
  - 再补全手机号
  这些步骤完成后，才能稳定进入 Pages 控制台创建 token。

## 本地部署 lightvela-preview

### 1. 安装依赖

```bash
cd frontend
pnpm install
```

### 2. 构建静态产物

当前测试环境构建固定走北京 auth 后端：

```bash
cd frontend
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
```

### 3. 链接测试项目（可选）

如果本地还没 link 过这个项目：

```bash
cd frontend
npx edgeone pages link
```

输入项目名：

```text
lightvela-preview
```

当前本地 link 文件是：

- `frontend/.edgeone/project.json`

它属于本地状态，不应提交。

### 4. 使用 API Token 发布

```bash
cd frontend
npx edgeone pages deploy dist -n lightvela-preview -e production -t <EDGEONE_PAGES_TOKEN>
```

说明：

- `-n lightvela-preview`：测试项目
- `-e production`：这里是测试项目自己的 production 环境，不是线网项目
- `-t`：`pablozhong` 自己创建的 Pages API Token

如果没有现成 token：

- 先完成控制台登录
- 再在 Pages 控制台创建 token
- 不要试图在仓库里寻找明文 token

## 推荐的环境变量写法

本地：

```bash
export EDGEONE_PAGES_TOKEN='...'
cd frontend
npx edgeone pages deploy dist -n lightvela-preview -e production -t "$EDGEONE_PAGES_TOKEN"
```

CI：

- 变量名建议：`EDGEONE_LIGHTVELA_PREVIEW_TOKEN`

示例：

```bash
cd frontend
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
npx edgeone pages deploy dist -n lightvela-preview -e production -t "$EDGEONE_LIGHTVELA_PREVIEW_TOKEN"
```

## 发布后的验证

1. 记录 CLI 输出里的：
   - `Deployment ID`
   - `EDGEONE_DEPLOY_URL`
2. 优先通过测试项目绑定的正式域名验证。
3. 如果是 `.edgeone.cool` 预览链接，必须保留完整 query 参数。

## 已发生的实际发布记录

这套流程已经在测试项目上实际执行过一次：

- 项目：`lightvela-preview`
- ProjectId：`pages-t27yodey8xhp`
- Deployment ID：`xgge29527l`

当次实际使用的命令是：

```bash
cd frontend
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
npx edgeone pages deploy dist -n lightvela-preview -e production
```

说明：

- 这次发布目标是**测试项目**
- 这里的 `production` 是测试项目自己的 production 环境
- 不是线网项目 `lightvela` 的 production

如果后续改为 `pablozhong` 自己创建的 Pages API Token，只需要把发布命令切换成：

```bash
cd frontend
npx edgeone pages deploy dist -n lightvela-preview -e production -t <EDGEONE_PAGES_TOKEN>
```

## 只读排障能力

`pablozhong` 已具备北京常用基础设施只读权限，适合做：

- 查看 TKE / Pod / CLB 相关现象
- 查看 CLS 日志
- 查看 Redis / CynosDB / TCR / VPC / CVM 基本状态

不适合做：

- 资源修改
- 生产发版
- 基础设施变更

## 需要更多子账号时

如果后续要继续创建更多“测试项目 only”或“只读 only”的受限子账号：

- 优先沿用 provisioning 文档里的流程和策略结构
- 优先直接使用脚本：
  - [scripts/create_edgeone_preview_subusers.py](/Users/skipzhang/code/mono2-clean/scripts/create_edgeone_preview_subusers.py)
- 默认联系 `Skipzhang`

前提：

- 需要一套具备 CAM 管理权限的主账号密钥
- 按现有文档复制并调整：
  - 子账号名
  - 测试项目 ProjectId
  - 只读资源范围

## 常见问题

### 1. `tsc: command not found`

先安装依赖：

```bash
cd frontend
pnpm install
```

### 2. `Deployment failed: localPath does not exist`

说明 `dist/` 还没构建出来：

```bash
cd frontend
ls dist
```

确认存在后再重新部署。

### 3. 裸 `.edgeone.cool` 地址返回 `401`

说明你丢了 EdgeOne 返回的临时参数。  
请使用 CLI 输出里的完整 URL。
