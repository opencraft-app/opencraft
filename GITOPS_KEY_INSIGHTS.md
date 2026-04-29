# Mono2 GitOps 工作流关键洞察

## 架构核心思想

### 1. 分支职责明确分离

**这是整个 GitOps 成功的关键：**

```
Master 分支（源码真源）
├─ 源代码编写
├─ CI 在此构建镜像
├─ 源 K8s 定义：k8s/base/* 和 k8s/overlays/*
└─ 一旦合并后就会触发自动构建

GitOps 分支（部署真源）
├─ Argo CD 唯一追踪源
├─ 仅包含已验证的、可部署的清单
├─ CI 投影 + 更新参数
├─ 镜像 Pin 值存储在此
└─ 环境参数集中管理
```

**为什么这样做：**
1. Master 变化频繁（代码编辑、重构），不适合作为部署源
2. GitOps 保持稳定，清晰的发布历史
3. 可以随时 Rollback（revert gitops commit）
4. Argo 自动同步不会被代码变化干扰

---

## 2. 参数驱动的关键机制

### 部署如何被触发：修改 `-platform.env` 文件

**这是 CI 和 Argo 之间的合约：**

```
CI 职责：
  1. 构建镜像 → 获得镜像 URL
  2. 在 argocd/services/<service>/<env>/ 中
     找到 <service>-platform.env 文件
  3. 更新其中的镜像相关环境变量
  4. Commit 并 Push 到 gitops 分支

Argo 职责：
  1. 检测到 gitops 有新 commit
  2. 运行 Kustomize build
  3. configMapGenerator 把 .env 转为 ConfigMap
  4. replacements 把 ConfigMap 值注入到资源
  5. 对比集群状态，发现差异
  6. 自动应用新清单
```

**关键文件：**
- `argocd/services/sandbox/shprod/sandbox-platform.env`
  ```env
  SANDBOX_API_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-api:shprod-20260424-null-divergence-9da9f73
  SANDBOX_REDIS_ADDR=10.15.192.115:6379
  SANDBOX_MYSQL_HOST=10.15.192.13
  ```

- `argocd/services/sandbox/common/kustomization.yaml`
  ```yaml
  replacements:
    - source:
        kind: ConfigMap
        name: sandbox-platform-values
        fieldPath: data.SANDBOX_API_IMAGE
      targets:
        - select:
            kind: Deployment
            name: sandbox-api
          fieldPaths:
            - spec.template.spec.containers.0.image
  ```

**工作原理：**
```
环境文件修改
  ↓
Kustomize configMapGenerator
  ↓
环境变量 → ConfigMap 数据
  ↓
replacements 查询 ConfigMap
  ↓
ConfigMap 值 → 注入到 Deployment.image
  ↓
Argo 对比差异
  ↓
自动更新 Deployment
  ↓
Kubernetes 滚动更新 Pod
```

---

## 3. 北京 vs 上海的权衡

### 北京（自动）：满足快速迭代

```
git push master
  ↓ (5-10 分钟)
自动上线
```

**快的原因：**
- CI 自动构建 + 投影 + 创建 MR
- 等待 check 通过（2 分钟）
- 自动合并 MR
- Argo 自动同步

**适用场景：**
- 测试环境，承受风险能力强
- 快速验证新功能
- 频繁迭代

### 上海（手动）：确保质量和安全

```
git push master
  ↓ (构建但不自动上线)
运维审批
  ↓ (人工决策)
手动上线
```

**慢但稳的原因：**
- CI 构建 + 投影
- MR 等待人工审批
- 运维验证清单后手动 Merge
- Argo 自动同步

**适用场景：**
- 生产环境，需要审批
- 稳定性第一
- 需要可追溯性

---

## 4. 两环境一镜像的设计

### 为什么北京和上海都要构建镜像？

**答案：为了独立部署的灵活性**

```
Master 构建
  ├─ beijing-sandbox 镜像
  │  └─ 推送到 lightclaw-bj8.tencentcloudcr.com
  └─ shprod 镜像
     └─ 推送到 lightclaw-shprod.tencentcloudcr.com
```

**为什么分开：**
1. **隔离性**：北京问题不影响上海
2. **回滚能力**：各环境独立版本历史
3. **网络性**：从本地仓库拉取镜像速度快
4. **合规性**：不同区域的数据存储要求

**Promote 模式下的上海发布：**
```
来源：从 master@SHA 构建
  ↓
结果：shprod 镜像生成
  ↓
存储：lightclaw-shprod.tencentcloudcr.com
  ↓
投影：argocd/services/*/shprod/*-platform.env
  ↓
审批：MR 等待人工
  ↓
上线：Argo 自动同步
```

---

## 5. Secret 加密的三层防护

### 为什么 Secret 需要特殊处理？

**分层加密模型：**

```
第一层：密钥管理（SSM）
  ├─ Tencent Cloud SSM
  └─ 长期权威真源

第二层：Git 存储（SOPS）
  ├─ 用 AGE 公钥加密
  ├─ 存储在 argocd/secrets/<env>/*.sops.yaml
  └─ Git 中安全存储

第三层：集群解密（Argo）
  ├─ AGE 私钥（Git 外注入）
  ├─ ksops 插件解密
  └─ 生成 K8s Secret
```

**关键保护点：**

| 层级 | 保护方式 | 存储位置 | 谁能访问 |
|------|--------|--------|--------|
| SSM | 密钥管理服务 | Tencent Cloud | 授权运维 |
| Git | SOPS + AGE 加密 | Git 仓库 | 有 Git 访问权的都能看（但看不懂） |
| 集群 | 仅在部署时解密 | K8s Secret | 集群内 Pod |

**最关键的设计：**
- AGE 私钥 **永远不进 Git**
- 通过 `bootstrap_argocd_sops_age.sh` Git 外注入
- 集群重建后需要重新注入
- 这样即使有人拿到 Git 的完整历史，也无法解密 Secret

---

## 6. 应用定义的两种模式

### 北京：ApplicationSet（参数化生成）

```yaml
generator: 扫描 argocd/catalogs/sandbox/*/*.yaml
template: 根据参数生成 Application

优势：
  ├─ 代码重用：一份 template，多个应用
  ├─ 易扩展：加一个 catalog 文件就是新应用
  └─ 集中配置：参数化管理
```

**实际案例：**
- 一个 ApplicationSet（sandbox-family）
- 扫描 argocd/catalogs/sandbox/beijing-sandbox/ 中的所有 YAML
- 每个文件定义一个服务（sandbox.yaml, ai-gateway.yaml 等）
- 自动生成 `sandbox-beijing-sandbox`, `ai-gateway-beijing-sandbox` 等应用

### 上海：显式 Application（传统方式）

```yaml
resources: 明确列出每个 Application YAML

优势：
  ├─ 清晰明确：看 apps/shprod/ 就知道有哪些应用
  ├─ 灵活控制：每个应用可以独立配置
  └─ 传统可靠：久经考验
```

**实际案例：**
- `argocd/apps/shprod/service-gateway.yaml` 对应一个应用
- `argocd/apps/shprod/sandbox.yaml` 对应另一个应用
- 清单明确，查找方便

**设计思路：**
- 北京：快速扩展，新服务只需加一个 catalog 文件
- 上海：稳定控制，新服务需要显式定义 Application

---

## 7. CI 脚本的核心职责划分

### 构建层（build-release-image.py）

```
单一职责：构建并推送镜像

输入：
  ├─ service
  ├─ env
  ├─ tag
  └─ 镜像仓库凭据

输出：
  └─ 镜像 URL（如 lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api:tag）

核心流程：
  ├─ docker login
  ├─ docker build
  └─ docker push
```

### 投影层（pin_image_to_gitops.sh）

```
单一职责：投影清单并更新镜像 Pin

输入：
  ├─ 服务名
  ├─ 环境
  ├─ 镜像 URL
  └─ 源 commit SHA

工作流：
  ├─ 创建 promote-* 分支
  ├─ 从 gitops 拉取最新清单
  ├─ 复制 argocd/services/<env>/ 到 promote 分支
  ├─ 更新 *-platform.env 中的镜像 URL
  ├─ Commit + Push
  ├─ 创建 MR
  └─ 轮询 commit check + 自动合并（北京）
```

### 编排层（build_and_promote_to_gitops.sh）

```
单一职责：协调整个 CI 流程

输入：
  ├─ Bundle 服务
  ├─ Pin 目标服务（CSV）
  ├─ 构建环境（CSV）
  └─ 自动投影环境（如 beijing-sandbox）

工作流：
  ├─ 对每个构建环境：
  │  ├─ build-release-image.py
  │  └─ 保存镜像 URL
  ├─ 对自动投影环境：
  │  └─ pin_image_to_gitops.sh
  └─ 对其他环境：
     └─ 等待手动投影
```

**关键设计：**
- 分离关注点：构建、投影、合并是独立的
- 可组合性：各脚本可单独调用
- 灵活性：支持 build+auto-merge（北京）和 build+manual-merge（上海）

---

## 8. 发布过程中的安全机制

### Commit Check（北京自动合并前）

```
MR 创建后，触发自动检查：
  ├─ 代码审视
  ├─ Manifest 验证
  ├─ 镜像扫描
  ├─ 部署预演
  └─ 其他自定义检查

只有全部通过，CI 才会自动合并
否则：MR 保持 Open，等待修复
```

**保证：**
- 不会部署到 gitops 的镜像一定经过验证
- 清单一定是有效的 Kubernetes YAML
- 镜像安全性一定达标

### 人工审批（上海）

```
MR 创建后，等待运维审批：
  ├─ 检查部署前后的差异
  ├─ 验证镜像版本正确
  ├─ 确认部署时机恰当
  ├─ 进行风险评估
  └─ 决定是否合并

人工审批的优势：
  ├─ 可以看到整体变化
  ├─ 可以协调多个服务部署
  ├─ 可以应对临时情况
  └─ 生产环境更有信心
```

---

## 9. 快速 Rollback 的能力

### 问题场景：上线后发现 bug

```
方案一：Git Revert（推荐）
  ├─ git revert gitops-commit-sha
  ├─ push to gitops
  └─ Argo 自动同步回前一个版本

方案二：直接修改 -platform.env
  ├─ 编辑 *-platform.env
  ├─ 改回旧的 SANDBOX_API_IMAGE
  ├─ commit + push
  └─ Argo 自动同步
```

**优势：**
- 都是几秒钟的操作
- 不需要重新构建镜像
- 不需要 Kubernetes 命令
- Git 历史完全可追溯

---

## 10. 为什么北京需要 Runtime 补丁？

### 问题：Argo 如何解密 SOPS 和运行 Kustomize 插件？

```
标准 Argo 开箱即用：
  ├─ 可以读 YAML
  ├─ 可以运行 Kustomize（基础功能）
  └─ 不能解密 SOPS
     不能运行 Kustomize Alpha 插件

北京新 Argo 需要补充：
  ├─ ksops 插件
  ├─ sops-age Secret 挂载
  ├─ KUSTOMIZE_PLUGIN_HOME 配置
  └─ Kustomize Alpha 功能启用
```

**解决方案：** `argocd/runtime/beijing-sandbox/`

```yaml
argocd-cm.yaml:
  ├─ 启用 kustomize.buildOptions
  ├─ kustomize --enable-alpha-plugins
  └─ kustomize --enable-exec

argocd-repo-server.yaml:
  ├─ 注入 ksops 可执行文件
  ├─ 挂载 sops-age Secret
  └─ 设置 KUSTOMIZE_PLUGIN_HOME
```

**自动应用：**
```
root-beijing-sandbox
  ├─ 扫描 argocd/apps/beijing-sandbox/
  ├─ 包括 argocd-runtime.yaml
  ├─ 自动创建 argocd-runtime-beijing-sandbox App
  ├─ 该 App 部署 runtime patch
  └─ repo-server 自动更新
```

**优势：**
- 重装 Argo 后不需要手工配置
- runtime patch 本身通过 GitOps 管理
- 清晰的依赖：root app 包含 runtime app

---

## 总结：系统设计的核心智慧

| 设计点 | 实现 | 收益 |
|--------|------|------|
| **分支拆分** | master 源码，gitops 部署 | 职责清晰，部署稳定 |
| **参数驱动** | -platform.env + Replacements | 环境配置集中，易于管理 |
| **两种模式** | ApplicationSet + 显式 App | 北京灵活，上海稳定 |
| **Secret 加密** | SOPS + AGE + ksops | 多层防护，安全可靠 |
| **快速反馈** | 北京 5-10 分钟上线 | 测试快速验证 |
| **生产安全** | 上海人工审批 | 风险可控 |
| **易于 Rollback** | Git Revert 或改参数 | 快速恢复 |
| **自动化 Runtime** | Runtime Argo App | 集群自动配置 |

---

## 接下来你可以...

1. **学习 Kustomize**：理解 replacements 和 configMapGenerator 如何协作
2. **学习 SOPS/AGE**：了解密钥管理的完整链条
3. **学习 Argo CD**：理解 Application 和 ApplicationSet 的区别
4. **实操练习**：
   - 修改一个环境参数并观察 Argo 同步
   - 手动 Revert gitops 一个 commit 观察回滚
   - 查看 promote-* 分支理解投影机制
   - 检查 CI 日志理解整个流程

