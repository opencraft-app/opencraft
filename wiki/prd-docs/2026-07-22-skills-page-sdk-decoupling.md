# Skills 页面去除 TEA SDK 依赖

## 基本信息

- 当前产品：LightVela Agent 控制台
- 需求状态：产品输入稿已确认，TAPD 待创建
- 创建日期：2026-07-22
- 最后更新时间：2026-07-22
- 需求类型：轻量技术改造
- 发布范围：国内站与国际站同步
- 优先级：P1

## 需求背景

国内站和国际站的 Skills 页面主体已经由 mono2 自有代码实现，搜索、推荐、详情、安装、卸载和已安装列表均不再依赖 SDK `SkillPanel`。

但用户进入 Skills 页面时，当前链路仍会先加载 `@tencent/tea-sdk-lightclaw` runtime、样式和脚本；只有 SDK 加载成功后才渲染 mono2 自有页面。这会产生三个问题：

- SDK 加载异常可能导致原本不依赖 SDK 的 Skills 页面不可用。
- Skills 页面仍受 SDK 版本和发布节奏影响，不能完全独立迭代。
- 页面会加载当前功能不需要的 SDK 资源，增加请求和解析成本。

不做本需求，Skills 页面将继续承受与自身功能无关的 SDK 可用性、版本和资源加载风险。

## 目标用户与场景

### 目标用户

- 使用国内站 `lightvela.com` Agent Skills 页面的用户。
- 使用国际站 `lightvela.ai` Agent Skills 页面的用户。
- 负责独立维护和发布 LightVela Skills 页面的产品与研发人员。

### 典型场景

- 用户从新窗口直接进入 Agent Skills 页面，页面不需要等待 TEA SDK 初始化即可展示。
- TEA SDK 资源加载异常时，用户仍可搜索、查看、安装和卸载技能。
- Skills 页面独立迭代或发布时，不需要等待 SDK 发版。

## 目标

### 产品结果

- Skills 页面具备独立、稳定的加载链路。
- SDK 发布或加载异常不影响技能管理能力。
- Skills 页面可以由 mono2 独立开发和发布。

### 业务目标

- 新窗口直接进入 Skills 页面时，TEA SDK runtime、scripts 和 styles 的加载请求数为 0。
- 模拟 SDK 加载失败时，Skills 页面核心功能可用率为 100%。
- 改造前后的 Skills 页面功能、结构、文案和操作回归通过率为 100%。

## 范围

### 本次包含

- 国内站 `lightvela.com` Skills 页面去除 SDK 运行时依赖。
- 国际站 `lightvela.ai` Skills 页面去除 SDK 运行时依赖。
- Skills 路由直接渲染 mono2 自有面板。
- 移除 Skills 链路中的 `SkillPanel`、SDK instance、feature flags 和 product config 参数。
- 清理仅服务于旧 SDK Skills 面板的兼容逻辑、类型和样式。
- 保留现有 `Skills`、`Experts`、`Installed`、`Create Skill` 四个标签。
- 保留现有搜索、精选、分类、详情、安装、卸载和已安装列表能力。
- 国内站与国际站同步上线。

### 本次不包含

- 从整个 frontend 项目删除 `@tencent/tea-sdk-lightclaw`。
- 改造模型和渠道页面；它们继续使用 SDK。
- 调整 Skills 页面视觉、文案、信息架构或交互流程。
- 改变 SkillHub、ClawHub、skills.sh 的接口和命令契约。
- 新增技能管理功能或数据埋点。
- 为其他未正式发布的运行环境保留 SDK `SkillPanel` 回退路径。

### 已知依赖

- mono2 自有 `SkillsDemoPanel` 继续承载国内站和国际站 Skills 页面。
- 国内站继续通过 SkillHub HTTP 接口获取技能，通过 `acli skills` 管理实例技能。
- 国际站继续通过 ClawHub、skills.sh 及对应 ACLI 命令管理技能。
- 实例命令继续通过现有 `execDebugCommand` 通道执行。

## 功能详细描述

### 页面加载链路

1. 用户进入国内站或国际站 Skills 路由。
2. 页面直接渲染 mono2 自有 Skills 容器和 `SkillsDemoPanel`。
3. 页面根据站点模式加载现有国内站或国际站数据层。
4. 页面不初始化 TEA SDK runtime，不导入 SDK scripts 或 styles，也不等待 SDK 加载结果。

### 功能保持

- `Skills`、`Experts`、`Installed`、`Create Skill` 标签及切换行为保持不变。
- 搜索、Featured、Categories、详情弹窗、安装、卸载和已安装列表保持不变。
- 国内站继续使用 SkillHub 数据与 `acli skills` 命令。
- 国际站继续使用 ClawHub、skills.sh 数据与对应命令。
- 现有加载态、空态、错误提示和重试逻辑保持不变。

### 边界条件与异常处理

- SDK 加载失败不得影响 Skills 页面。
- 搜索接口或实例命令失败时，继续沿用现有错误提示和重试逻辑。
- 从模型或渠道切换到 Skills 时，Skills 页面正常展示，不依赖已经加载的 SDK 状态。
- 从 Skills 切换到模型或渠道时，对应页面仍可正常按需加载 SDK。

### Demo 与原型判断

本次不新增 Demo、交互设计稿或原型。需求不改变任何用户可见结构或操作，现有线上 Skills 页面即为视觉和交互基线；研发完成后通过国内站与国际站浏览器回归对比验证。

### 数据埋点需求

本次不新增埋点。继续使用现有前端错误监控和操作失败日志观测页面稳定性。

## 发布站点与同步策略

- 发布范围：双站同步。
- 国际站是否同步：是，发布到 `lightvela.ai`。
- 国内站是否同步：是，发布到 `lightvela.com`。
- 差异化原因：两站继续沿用现有数据源、安装命令和语言差异，不新增差异化逻辑。
- 路由与内容影响：Agent 控制台 Skills 页面；不新增路由、文案、图片、metadata 或 sitemap 变更。
- 上线顺序：国内站与国际站同步上线。

## LightVela 影响面

- 前端页面/路由：Skills 路由、Skills 容器组件、SDK 动态加载边界及遗留 SDK 样式。
- Hermes/OpenClaw/运行时：不改变；继续通过现有 `execDebugCommand` 执行技能命令。
- SkillHub/MCP/工具：不改变 SkillHub、ClawHub、skills.sh 的接口、数据结构和命令。
- SDK/文档/运营：不修改 SDK，也不升级版本；仅解除 Skills 页面的消费关系。无运营内容变更。
- 权限/安全/数据：无新增权限、安全或数据处理要求。

## 非功能性需求

- 性能：新窗口直接进入 Skills 页面时，不加载 TEA SDK runtime、scripts 和 styles；页面加载性能不得低于改造前基线。
- 兼容性：沿用现有浏览器、设备和分辨率兼容要求。
- 安全与权限：不改变实例命令权限、接口鉴权或用户数据处理方式。
- 国际化：不新增文案；现有中英文文案和语言切换行为保持不变。
- 无障碍：现有键盘操作、焦点和语义标签行为不得回退。

## 产物交接

- 产品：本 PRD 作为需求、范围和验收事实源。
- 前端：完成 Skills 路由解耦、遗留兼容代码清理、单元测试和双站浏览器回归。
- QA：验证双站四个标签、搜索、详情、安装、卸载、已安装列表及 SDK 异常隔离。
- 发布：国内站与国际站同步发布，并核对 Skills 首次加载网络请求。
- SDK 维护方：无需改动或发版，仅需知悉 Skills 页面不再消费 SDK `SkillPanel`。

## 方案决策

### 采用方案

采用方案 A：Skills 路由彻底独立。

进入 Skills 页面时，直接使用 `botId` 和 `execDebugCommand` 渲染 mono2 自有 Skills 面板，不再初始化 SDK runtime。模型和渠道页面继续按需加载 SDK，二者的依赖边界保持不变。

### 选择理由

- 能直接消除 SDK 加载失败对 Skills 页面的影响。
- 不改变现有页面功能、交互、数据源和命令契约。
- 改动集中在 Skills 路由和组件边界，范围清晰。
- Skills 页面后续可以独立开发和发布。

### 备选方案与取舍

#### 备选一：保留 SDK 兼容分支

- 优点：保留其他运行环境回退到 SDK `SkillPanel` 的能力。
- 缺点：继续维护当前正式站点不需要的双实现，容易再次引入 SDK 耦合。
- 结论：不采用。

#### 备选二：国内站与国际站分别拆页

- 优点：站点边界更强。
- 缺点：重复共享 UI、状态和安装逻辑，增加双站同步维护成本。
- 结论：不采用。

### 延后或不做

- frontend 全局去除 TEA SDK。
- 模型和渠道页面的 SDK 替换。
- Skills 页面功能或视觉升级。

## 验收标准

1. 新窗口直接进入国内站 Skills 页面时，不请求或执行 TEA SDK runtime、scripts 和 styles。
2. 新窗口直接进入国际站 Skills 页面时，同样不加载上述 SDK 资源。
3. SDK 动态导入失败时，国内站和国际站 Skills 页面仍能正常展示。
4. `Skills`、`Experts`、`Installed`、`Create Skill` 四个标签及切换行为保持不变。
5. 双站的搜索、详情、安装、卸载和已安装列表功能保持正常。
6. 国内站继续使用 SkillHub 数据和 `acli skills` 命令。
7. 国际站继续使用 ClawHub、skills.sh 数据及对应命令。
8. 模型和渠道页面继续正常使用 SDK，不受本次改造影响。
9. Skills 链路不再接收或引用 SDK `SkillPanel`、instance、feature flags、product config。
10. 仅供旧 SDK Skills 面板使用的样式和兼容逻辑被清理，且不存在无效引用。
11. 双站类型检查、相关单元测试及浏览器回归通过。
12. 页面结构、文案和交互与改造前一致。

## 发布与观测

- 灰度/开关：不新增；随国内站和国际站前端版本同步发布。
- 日志/埋点/指标：观测 Skills 页面加载成功率、前端异常、搜索和安装操作失败情况。
- 性能验证：比较改造前后 Skills 首次加载的网络请求，确认不再出现 SDK 相关资源。
- 回滚：回滚对应前端版本；不涉及后端、SDK 或实例数据回滚。

## 待确认问题

- 无阻塞待确认问题。
