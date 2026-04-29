# Mono2 GitOps 工作流完整文档

## 文档导航

本项目的 GitOps 工作流包含三份文档，按场景选择阅读：

### 📖 1. GITOPS_WORKFLOW_ANALYSIS.md（完整技术深度分析）
**适合：需要深入理解架构的工程师**

- 1143 行详细内容
- **七大核心问题完整回答：**
  1. Argo CD Application 如何定义和组织
  2. GitOps 真源是哪个分支/仓库
  3. 镜像如何构建和标记
  4. 部署清单如何更新并触发 Argo 同步
  5. 北京和上海环境的部署差异
  6. Secret 的加密管理机制
  7. 从代码变更到生产的完整发布流程

**内容结构：**
```
├─ 一、Argo CD Application 定义和组织架构
│  ├─ 应用架构层级（Root + Leaf）
│  ├─ Root Application 定义示例
│  ├─ ApplicationSet 动态生成（北京）
│  ├─ 显式 Application（上海）
│  └─ AppProject 权限控制
├─ 二、GitOps 真源（Source of Truth）
│  ├─ 分支模型详解
│  ├─ 分支职责拆分
│  ├─ Argo 配置指向
│  └─ 更新流程示意
├─ 三、镜像构建、标记和推送
│  ├─ 元数据定义（release-bundles.yaml）
│  ├─ 镜像标记规范
│  ├─ 构建脚本详解
│  └─ CI 完整流程
├─ 四、部署清单更新和同步触发
│  ├─ 清单组织结构
│  ├─ 三层 Kustomize 架构
│  ├─ 参数驱动机制
│  ├─ Argo 同步流程
│  └─ 北京 vs 上海方式差异
├─ 五、双环境部署差异
│  ├─ Argo 控制面差异表
│  ├─ 源码层差异
│  ├─ 部署参数差异
│  ├─ CI 流程差异
│  └─ Kustomize 配置差异
├─ 六、Secrets 管理（SOPS + AGE + Ksops）
│  ├─ 加密架构概览
│  ├─ Secret 存储位置
│  ├─ SOPS 配置
│  ├─ Argo 中的解密
│  ├─ Ksops Secret Generator
│  ├─ 北京特殊配置
│  └─ Secret 权威来源
├─ 七、完整发布流程
│  ├─ 流程总览
│  ├─ 北京流程详细步骤（8 步）
│  ├─ 上海流程详细步骤（9 步）
│  ├─ 时间线对比
│  ├─ 失败处理
│  ├─ 流程示意图
├─ 八、关键脚本和配置文件速查表
└─ 九、常见问题和故障排除

大小：32KB | 读完时间：30-45 分钟
```

**何时阅读：**
- 第一次深入了解 GitOps 架构
- 需要了解某个技术细节的原理
- 作为项目技术文档参考

---

### 🎯 2. GITOPS_QUICK_REFERENCE.md（快速参考手册）
**适合：快速查找信息，日常运维参考**

- 504 行快速查询表和命令集
- **关键内容包括：**
  - 核心概念速记
  - 文件位置速查表
  - 部署参数驱动机制
  - 镜像标记和位置
  - 北京/上海 CI 流程对比（带流程图）
  - Secret 管理
  - 快速操作指南
  - 故障排查表
  - 常用命令速查
  - 环境变量和配置

**内容结构：**
```
├─ 核心概念速记（分支模型、架构、关键路径）
├─ 快速查询表
│  ├─ 文件位置速查
│  └─ 服务目录结构
├─ 部署参数驱动机制（三层 Kustomize）
├─ 镜像标记和位置（北京 + 上海）
├─ CI 流程对比（北京自动 vs 上海手动）
├─ Secret 管理
├─ 快速操作指南（4 个常用场景）
├─ 故障排查速查表
├─ 相关命令速查
├─ 关键环境变量和配置
├─ 权限和访问控制
└─ 常用链接

大小：12KB | 查询时间：2-5 分钟/次
```

**何时使用：**
- 需要快速找到某个文件或命令
- 作为日常工作的速查手册
- 在故障排查时快速定位问题
- 新人入职时的快速入门表

---

### 💡 3. GITOPS_KEY_INSIGHTS.md（架构洞察和设计智慧）
**适合：想理解为什么这样设计，学习架构思想**

- 470 行深层设计原理解析
- **10 个核心设计洞察：**
  1. 分支职责明确分离（为什么拆分？）
  2. 参数驱动的关键机制（部署如何被触发？）
  3. 北京 vs 上海的权衡（快速 vs 稳定）
  4. 两环境一镜像的设计（为什么要构建两份？）
  5. Secret 加密的三层防护（如何保证安全？）
  6. 应用定义的两种模式（ApplicationSet vs 显式）
  7. CI 脚本的职责划分（如何组织脚本？）
  8. 发布过程中的安全机制（Check + 审批）
  9. 快速 Rollback 的能力（为什么能快速回滚？）
  10. 北京为什么需要 Runtime 补丁（特殊配置原因）

**内容结构：**
```
├─ 10 个设计洞察（每个深度讲解）
│  ├─ 问题陈述
│  ├─ 解决方案
│  ├─ 核心原理
│  └─ 优势分析
├─ 设计智慧总结表
│  └─ 设计点 | 实现 | 收益 对应表
└─ 接下来学习方向

大小：11KB | 学习时间：15-25 分钟
```

**何时阅读：**
- 想理解架构设计的深层原理
- 准备为系统添加新功能或修改
- 进行 Code Review 时需要理解设计意图
- 教导新团队成员时讲解设计思想

---

## 推荐阅读路径

### 🚀 路径 A：快速上手（适合新人）
```
1. 这个文件（理解全局）
   ↓
2. GITOPS_KEY_INSIGHTS.md（理解设计思想）
   ↓
3. GITOPS_QUICK_REFERENCE.md（学习常用操作）
   ↓
4. 动手实践：修改一个环境参数，观察 Argo 同步
```
**预计时间：1-2 小时**

### 📚 路径 B：深度理解（适合架构师/高级工程师）
```
1. 这个文件（了解全局）
   ↓
2. GITOPS_WORKFLOW_ANALYSIS.md（逐节深入阅读）
   ↓
3. 查看实际代码：
   - argocd/root/beijing-sandbox.yaml
   - argocd/services/sandbox/common/kustomization.yaml
   - scripts/build_and_promote_to_gitops.sh
   ↓
4. 运行本地测试：Kustomize build，SOPS 解密等
```
**预计时间：3-4 小时**

### 🔧 路径 C：问题排查（适合故障处理）
```
1. GITOPS_QUICK_REFERENCE.md → 故障排查表
   ↓
2. 如果需要深入理解：
   查看 GITOPS_WORKFLOW_ANALYSIS.md 对应章节
   ↓
3. 查看 CI 日志或 Argo 事件
```
**预计时间：10-30 分钟（取决于问题复杂性）**

---

## 关键概念速记

### 核心流程：代码到部署

```
┌─ Master 分支（源码真源）
│  ├─ 开发者编写代码
│  ├─ 源 K8s 定义（k8s/base/*）
│  └─ CI 构建镜像
│
↓ CI 自动化
│
├─ 镜像推送到 TCR
│
├─ 投影到 Promote 分支
│  ├─ 复制 argocd/services/<env>/
│  └─ 更新 *-platform.env（镜像 URL）
│
├─ 创建 MR 到 GitOps 分支
│
├─ 【北京】自动合并 ─→ 【上海】等待审批
│
↓ GitOps 分支更新
│
└─ Argo CD 自动同步
   ├─ Kustomize build（读取新参数）
   ├─ 对比集群状态
   └─ 应用新清单（Pod 滚动更新）
```

### 三个关键文件

| 文件 | 位置 | 用途 | 谁修改 |
|------|------|------|--------|
| **release-bundles.yaml** | `scripts/` | 定义服务的构建参数（Dockerfile、镜像仓库等） | 开发者 |
| **-platform.env** | `argocd/services/<service>/<env>/` | 环境参数，**部署触发点** | CI 自动更新 |
| **kustomization.yaml** | `argocd/services/<service>/common/` | Replacements 规则，如何把参数注入到资源 | 开发者 |

### 部署参数如何工作

```
-platform.env（环境变量）
  ↓
Kustomize configMapGenerator
  ↓
ConfigMap 数据
  ↓
replacements（查询 ConfigMap）
  ↓
Deployment.image = ConfigMap.SANDBOX_API_IMAGE
  ↓
Argo 对比差异
  ↓
Pod 滚动更新
```

---

## 快速导航

### 我想...

| 需求 | 查看文档 | 说明 |
|------|--------|------|
| **理解整个架构** | GITOPS_WORKFLOW_ANALYSIS.md 第一部分 | Argo CD 应用层级 |
| **查找文件位置** | GITOPS_QUICK_REFERENCE.md | "快速查询表" 部分 |
| **理解部署原理** | GITOPS_KEY_INSIGHTS.md 第 2 节 | 参数驱动机制 |
| **了解发布流程** | GITOPS_WORKFLOW_ANALYSIS.md 第七部分 | 完整 8-9 步流程 |
| **管理 Secret** | GITOPS_WORKFLOW_ANALYSIS.md 第六部分 | SOPS + AGE |
| **查找命令** | GITOPS_QUICK_REFERENCE.md | 相关命令速查 |
| **处理故障** | GITOPS_QUICK_REFERENCE.md | 故障排查表 |
| **学习设计思想** | GITOPS_KEY_INSIGHTS.md | 10 大洞察 |
| **修改部署参数** | GITOPS_QUICK_REFERENCE.md | 快速操作指南 |
| **理解北京特殊性** | GITOPS_KEY_INSIGHTS.md 第 10 节 | Runtime 补丁 |

---

## 文档版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-04-28 | 初始版本，基于 mono2 当前架构 |

---

## 相关资源

### 官方文档
- `.ci/README.md` - CI 流程文档
- `argocd/README.md` - Argo CD 架构
- `README.md` - 项目主文档
- `AGENTS.md` - 发布和开发约定

### 关键脚本
- `scripts/build-release-image.py` - 镜像构建
- `scripts/build_and_promote_to_gitops.sh` - 完整 CI
- `scripts/pin_image_to_gitops.sh` - 投影和 MR
- `.ci/init.sh` - CI 环境初始化

### 代码示例
- `argocd/root/beijing-sandbox.yaml` - Root App
- `argocd/apps/beijing-sandbox/sandbox-family-appset.yaml` - ApplicationSet
- `argocd/services/sandbox/common/kustomization.yaml` - Replacements 配置
- `argocd/services/sandbox/shprod/sandbox-platform.env` - 部署参数

---

## 贡献和反馈

如果发现文档中有错误或遗漏，请：

1. 开启 Issue 描述问题
2. 提交 MR 修正
3. 在团队讨论中反馈

---

## 许可证

这些文档是 mono2 项目的一部分，遵循项目的许可证协议。

