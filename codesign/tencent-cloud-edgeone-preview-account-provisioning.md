# 腾讯云 EdgeOne Preview 子账号创建记录

这份文档沉淀一次已经完成的腾讯云权限建设过程：使用腾讯云主账号创建一个**只允许操作测试项目 `lightvela-preview` 的 EdgeOne Pages 子账号**，并额外授予它**北京常用基础设施只读**能力，便于测试环境排障。

目标对象：

- 腾讯云子账号：`pablozhong`
- EdgeOne Pages 测试项目：`lightvela-preview`
- ProjectId：`pages-t27yodey8xhp`

## 最终结果

本次没有创建 CAM Role。  
实际创建的是：

1. 一个 CAM 子账号
   - 用户名：`pablozhong`
   - UIN：`100048437661`
   - UID：`25025877`
   - 控制台登录：已开启
   - 首次登录强制改密：已开启

2. 两条自定义 CAM 策略
   - `eo-pages-lightvela-preview-only-20260427`
   - `beijing-common-readonly-20260427-v2`

3. 一把给子账号使用的 CAM AccessKey
   - 已创建
   - **SecretId / SecretKey 不写入仓库**
   - 需要通过安全渠道单独交付

## 这份文档的作用

这份文档不是给“只想发一次测试版本”的人看的。  
它更适合：

- 需要理解权限为什么这么拆的 agent
- 需要继续创建更多受限子账号的维护者
- 需要审计或复盘当前 EO / 北京只读权限模型的人

## 为什么这样设计

### 1. 为什么不直接给主账号或现有大权限账号

测试环境发布需要的真实边界是：

- 能操作 EdgeOne Pages 测试项目
- 不能碰生产 Pages 项目
- 能查看北京测试基础设施
- 不能改北京基础设施

如果直接复用主账号或已有大权限账号，后续很容易：

- 误操作生产项目
- 误扩散权限到其他 EO / 云资源

因此这里采用：

- **单独子账号**
- **单独自定义策略**
- **单独 API Token / AccessKey**

### 2. 为什么不只靠 EdgeOne Pages API Token

分析结论：

- EdgeOne Pages API Token 不是一个独立的细粒度 scope 系统
- 它更像“这个身份在 Pages 上的操作凭证”
- 因此真正的权限边界仍然来自**子账号本身的 CAM 权限**

所以正确顺序是：

1. 先创建子账号
2. 给子账号最小 CAM 权限
3. 再让这个子账号自己创建 Pages API Token

### 3. 为什么测试项目要独立成 `lightvela-preview`

分析结论：

- EdgeOne Pages 的 `preview` / `production` 是**同一个项目内的两个环境**
- 单靠 token 或 CLI 参数，无法形成“只能 preview、不能 production”的强权限边界

因此真正稳妥的隔离方式是：

- 生产项目：`lightvela`
- 测试项目：`lightvela-preview`

这样即使测试子账号执行：

```bash
edgeone pages deploy -n lightvela-preview -e production
```

它影响的仍然只是**测试项目自己的 production 环境**，而不是线网项目。

### 4. 为什么北京只读没有做成“腾讯云全产品北京只读”

分析结论：

- 腾讯云 CAM 通用条件键里没有一个可直接全局复用的 `qcs:region` 条件来表达“所有服务都只限 ap-beijing”
- 不同云产品的资源 ARN 形式也不同
- 一刀切上 `QcloudReadOnlyAccess` 会变成**全地域只读**，不符合“只限北京”的要求

因此本次采取的是更稳的策略：

- 不做“全产品全地域只读”
- 不做“全产品北京只读”
- 只给**北京常用基础设施只读**

覆盖到当前确实用于测试排障的服务：

- `cvm`
- `vpc`
- `tke`
- `redis`
- `tcr`
- `clb`
- `cls`
- `cynosdb`
- `monitor`

### 5. 为什么不复用现有 `lightclaw-test-beijing-only`

我们检查过账户里已有的历史策略：

- `lightclaw-test-beijing-only`

它的问题是：

- 它是北京多服务的**全权限**
- 不符合“只读 only”的目标

因此没有复用，而是新建了一条真正的只读策略。

### 6. 为什么后续仍然可以继续按文档创建更多子账号

分析结论：

- 当前流程已经把“子账号创建”“EO Pages 最小权限”“北京只读权限”“测试项目隔离”拆成了独立步骤
- 这些步骤彼此之间耦合不高
- 只要持有一套**具备 CAM 管理权限的主账号密钥**，就可以按同样方式继续创建新的受限子账号

后续需要调整的变量通常只有：

- 子账号名
- 目标测试项目名 / ProjectId
- 需要开放的只读资源集合

因此这份文档本身就是可复制的模板，而不是一次性的操作记录。

## 实际创建过程

### 步骤 1：确认目标项目存在

已确认：

- 项目名：`lightvela-preview`
- ProjectId：`pages-t27yodey8xhp`

这意味着：

- 不需要给子账号 `CreatePagesResources`
- 只需要让它操作现有测试项目

### 步骤 2：创建子账号

使用 CAM API：

```bash
tccli cam AddUser \
  --Name pablozhong \
  --Remark 'EO Pages preview-only operator for lightvela-preview' \
  --ConsoleLogin 1 \
  --UseApi 0 \
  --NeedResetPassword 1
```

结果：

- 用户名：`pablozhong`
- UIN：`100048437661`
- UID：`25025877`

说明：

- 当时先不开 `UseApi`
- 等策略绑完后，再专门创建一把 AccessKey

### 步骤 3：创建 EO Pages 最小权限策略

策略名：

- `eo-pages-lightvela-preview-only-20260427`

PolicyId：

- `271353894`

策略内容：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "teo:CreateCredential",
        "teo:CreateUploadUrl",
        "teo:DescribeZones"
      ],
      "resource": [
        "*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "teo:DescribePagesResources",
        "teo:ModifyPagesResources",
        "teo:DescribeDeployHistory",
        "teo:DescribeEnvironments"
      ],
      "resource": [
        "qcs::teo::uin/100045199955:zone/pages-t27yodey8xhp"
      ]
    }
  ]
}
```

设计意图：

- `CreateCredential`
  - 允许这个子账号创建 EO / Pages API Token
- `CreateUploadUrl`
  - 允许上传 Pages 部署产物
- `DescribeZones`
  - 允许控制台/CLI 获取必要的 EO 站点上下文
- `DescribePagesResources` / `ModifyPagesResources`
  - 只允许查看/修改 `lightvela-preview`
- `DescribeDeployHistory` / `DescribeEnvironments`
  - 允许查看部署历史和环境信息

没有给：

- `teo:CreatePagesResources`
- `teo:DeletePagesResources`

### 步骤 4：创建北京常用基础设施只读策略

策略名：

- `beijing-common-readonly-20260427-v2`

PolicyId：

- `271354084`

策略内容：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "cvm:Describe*"
      ],
      "resource": [
        "qcs::cvm:ap-beijing::instance/*",
        "qcs::cvm:ap-beijing::image/*",
        "qcs::cvm:ap-beijing::keypair/*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "vpc:Describe*"
      ],
      "resource": [
        "qcs::vpc:ap-beijing::vpc/*",
        "qcs::vpc:ap-beijing::subnet/*",
        "qcs::vpc:ap-beijing::routeTable/*",
        "qcs::vpc:ap-beijing::securitygroup/*",
        "qcs::vpc:ap-beijing::nat/*",
        "qcs::vpc:ap-beijing::eip/*",
        "qcs::vpc:ap-beijing::eni/*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "tke:Describe*"
      ],
      "resource": [
        "qcs::tke:ap-beijing::cluster/*",
        "qcs::tke:ap-beijing::nodepool/*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "redis:Describe*"
      ],
      "resource": [
        "qcs::redis:ap-beijing::instance/*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "tcr:Describe*",
        "tcr:List*"
      ],
      "resource": [
        "qcs::tcr:ap-beijing::instance/*",
        "qcs::tcr:ap-beijing::repository/*",
        "qcs::tcr:ap-beijing::repo/*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "clb:Describe*"
      ],
      "resource": [
        "qcs::clb:ap-beijing::clb/*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "cls:Describe*",
        "cls:SearchLog",
        "cls:Get*"
      ],
      "resource": [
        "qcs::cls:ap-beijing::logset/*",
        "qcs::cls:ap-beijing::topic/*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "cynosdb:Describe*"
      ],
      "resource": [
        "qcs::cynosdb:ap-beijing::instance/*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "monitor:Describe*",
        "monitor:GetMonitorData"
      ],
      "resource": [
        "qcs::monitor:ap-beijing:uin/100045199955:*"
      ]
    }
  ]
}
```

设计意图：

- 只给北京常用基础设施排障读权限
- 明确按 `ap-beijing` 资源范围收敛
- 不给任何写动作

### 步骤 5：把两条策略绑定到子账号

绑定对象：

- `AttachUin = 100048437661`

最终确认结果：

- `eo-pages-lightvela-preview-only-20260427`
- `beijing-common-readonly-20260427-v2`

都已经绑定到 `pablozhong`

### 步骤 6：为子账号创建 AccessKey

后续又补了一把给 `pablozhong` 的 CAM AccessKey，目的是：

- 可用于程序化调用
- 可用于排查北京环境问题
- 也可用于配合 CI / 脚本

注意：

- AccessKey 已创建
- **实际 SecretId / SecretKey 不应写入仓库**
- 应通过密码管理器、SSM 或安全渠道单独交付

## 使用这套凭据继续推进 Pages 发布的实际过程

这一段记录的是：在完成子账号、策略和 AccessKey 建设之后，如何继续推进 `lightvela-preview` 的测试发布。

### 步骤 7：用子账号 AccessKey 验证 EO 权限边界

完成 AccessKey 创建后，实际拿这组子账号凭据做了两类验证：

1. 能否调用 EO 侧 API
2. 能否只看到 / 操作 `lightvela-preview`

结论：

- 子账号的 EO 权限策略已生效
- 可以访问 EO / Pages 所需的最小能力边界
- 北京常用基础设施只读策略也已生效

### 步骤 8：尝试通过 EO API / 控制台创建 Pages API Token

分析目标是：

- 不依赖主账号
- 让 `pablozhong` 自己为 `lightvela-preview` 创建 Pages API Token

实际过程分两条线：

#### 8A. 尝试走 EO API

做过的验证：

- EO 的权限文档中存在 `CreateCredential` 动作
- 并且它是操作级权限，资源为 `*`

因此做了进一步尝试：

- 用 `pablozhong` 的 AccessKey 按腾讯云 API 3.0 签名方式直接请求 `teo.tencentcloudapi.com`
- 调用 `CreateCredential`

结论：

- 请求已经能打通到 EO API
- 说明 `teo:CreateCredential` 权限本身可用
- 但当时没有拿到可直接用于 `edgeone pages deploy -t ...` 的 Pages API Token 返回值

因此，基于当时可获得的公开文档和可验证结果，不能把“通过 EO API 直接生成 Pages API Token”认定为一条已稳定验证的标准流程。

#### 8B. 尝试走子账号控制台

随后进一步用浏览器自动化尝试：

1. 使用 `pablozhong@100045199955` 登录腾讯云子账号控制台
2. 首次登录时被要求：
   - 重置密码
3. 重置密码完成后，又被要求：
   - 绑定手机号 / 完善手机信息

这一步导致的结果是：

- 在当次会话里，子账号还没真正进入 Pages 控制台
- 因而没有直接在该次流程里完成“由 `pablozhong` 创建 Pages API Token”

### 步骤 9：先完成测试项目发布

因为子账号控制台流程被手机号补全卡住，而测试发布本身又需要尽快验证前端行为，所以当次实际发布采用了：

- 已有本机 EdgeOne 登录态
- 目标项目仍然严格指向 `lightvela-preview`

换句话说：

- **权限建设使用的是主账号 + 子账号凭据**
- **最终测试发布的执行身份是本机现有 EdgeOne 登录态**
- **发布目标是我们刚完成权限收敛的测试项目 `lightvela-preview`**

这一步的目标是先验证：

- `frontend` 构建产物是否正确
- `lightvela-preview` 项目是否能正常承接部署
- EdgeOne 预览链路是否工作正常

### 步骤 10：实际发布 `frontend` 到 `lightvela-preview`

实际构建命令：

```bash
cd frontend
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
```

实际发布命令：

```bash
cd frontend
npx edgeone pages deploy dist -n lightvela-preview -e production
```

当次实际结果：

- 项目：`lightvela-preview`
- ProjectId：`pages-t27yodey8xhp`
- Deployment ID：`xgge29527l`

说明：

- 这里的 `-e production` 指的是**测试项目自身的 production 环境**
- 它不等于线网项目 `lightvela` 的 production
- 因为项目已隔离，所以即使环境参数是 `production`，权限边界仍然是测试项目

### 步骤 11：获得可预览链接

发布成功后，EdgeOne CLI 返回了一条带临时参数的预览链接。

这一类链接通常形如：

```text
https://<subdomain>.edgeone.cool?eo_token=...&eo_time=...
```

关键结论：

- 预览链接需要保留完整 query 参数
- 删除 `eo_token` / `eo_time` 后，裸 `.edgeone.cool` 地址可能返回 `401`

因此文档里只沉淀模式与处理原则，不把带 token 的完整临时链接长期写进仓库。

## 扩展更多子账号的建议

如果后续还要再创建更多受限子账号，建议继续沿用这套模式：

1. 先拆项目边界
   - 测试项目 / 生产项目分离
2. 再拆身份边界
   - 每个用途一个子账号
3. 再拆策略边界
   - EO Pages 最小权限
   - 只读排障权限
4. 最后才发 AccessKey / Pages API Token

默认联系人：

- `Skipzhang`

前提条件：

- 持有具备 CAM 管理权限的主账号密钥

如果不满足这个前提，就不能直接复用本文步骤创建新子账号。

## 实际过程的最终结论

这次完整实操可以总结为：

1. **成功完成**
   - 创建 `pablozhong`
   - 创建并绑定两条 CAM 策略
   - 创建 `pablozhong` 的 AccessKey
   - 验证 `lightvela-preview` 项目存在且策略边界正确
   - 成功把 `frontend` 发布到 `lightvela-preview`
   - 成功拿到可访问的预览链接

2. **当次没有直接走通**
   - 由 `pablozhong` 自己在控制台创建 Pages API Token

3. **原因**
   - 子账号首次登录需要先改密
   - 改密后又被腾讯云控制台要求补全手机号
   - 这一步阻断了“当次直接在 Pages 控制台创建 token”的闭环

4. **对后续流程的影响**
   - 权限设计本身已经完成
   - 项目隔离本身已经完成
   - 后续只要 `pablozhong` 完成手机号补全，就可以继续：
     - 登录 Pages 控制台
     - 创建自己的 API Token
     - 用该 token 独立发布 `lightvela-preview`

## 当前对象清单

当前已经存在的对象：

### 子账号

- `pablozhong`

### 自定义策略

- `eo-pages-lightvela-preview-only-20260427`
- `beijing-common-readonly-20260427-v2`

### 测试项目

- `lightvela-preview`
- `pages-t27yodey8xhp`

### 未创建的对象

- 未创建 CAM Role
- 未创建生产项目权限策略

## 后续如何使用

后续使用方式分两条：

1. **Pages 发布**
   - 使用 `pablozhong` 登录腾讯云控制台
   - 在 EdgeOne Pages 里创建 API Token
   - 只发布 `lightvela-preview`

2. **北京排障**
   - 用 `pablozhong` 的 AccessKey 或控制台身份
   - 读取北京常用基础设施状态
   - 不做写操作

实际发布操作说明见：

- [edgeone-preview-operator.md](./edgeone-preview-operator.md)

## 敏感信息处理说明

以下敏感信息**不应写入仓库**：

- 初始控制台密码
- 子账号 AccessKey 的 `SecretId`
- 子账号 AccessKey 的 `SecretKey`
- Pages API Token 明文

仓库文档里只保留：

- 用户名
- UIN / UID
- 策略名 / PolicyId
- 项目名 / ProjectId
- 策略 JSON

这样后续能复盘权限设计，但不会把真正凭据暴露到 Git 历史里。

## 脚本化入口

在完成一次手工验证后，后续继续批量创建同类受限子账号，优先走脚本：

- [scripts/create_edgeone_preview_subusers.py](/Users/skipzhang/code/mono2-clean/scripts/create_edgeone_preview_subusers.py)

脚本设计目标：

- 用最小交互重复执行同一套子账号创建流程
- 保持和本文一致的默认策略集
- 把敏感结果写入本地受限权限文件，而不是打印到终端

典型用法：

```bash
TENCENTCLOUD_SECRET_ID=... \
TENCENTCLOUD_SECRET_KEY=... \
scripts/create_edgeone_preview_subusers.py <username1> <username2> ...
```

脚本当前行为：

- 自动去重用户名
- 若账号不存在则创建
- 若账号已存在则复用并补齐策略
- 若账号已有两把 AccessKey，则拒绝继续创建新 key，避免在拿不到旧 Secret 的前提下破坏现状
- 默认把结果写到：
  - `~/.codex/tmp/edgeone-preview-subusers-<random>.json`
