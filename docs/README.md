# OpenCraft 服务文档

OpenCraft 是多端 Agent Workbench 核心，包含 Chat Runtime、Web Workbench、Expo 客户端、Electron 桌面壳和 AppServer 适配层。下游产品/Hermes 产品与 Agent Console 共享适配由下游产品持有；公开核心保持独立运行时、包管理器、构建矩阵和发布所有权。

## 权威入口

- 服务所有权、依赖和生成路径：[仓库元数据](../config/catalog-info.yaml)。
- Agent 工作规则：[AGENTS.md](../AGENTS.md)。
- 项目维护方法与验收路由：[OpenCraft 维护总纲 Skill](../.agents/skills/opencraft-maintenance/SKILL.md)；不替代下列正式架构文档。
- 仓库历史与下游消费契约：[仓库历史与下游消费](upstream-history.md)。
- 平台与插件架构：[平台架构专题索引](platform-architecture.md)、[插件架构](plugin-architecture.md)。
- 运行观测平台：[定位、服务与数据/CLI/Skill 规格 V1](observability-platform.md)、[功能与非功能验收矩阵](observability-acceptance.md)；当前为待实现规格，最终以真实部署验收为准。
- 主体与协作设计纲领：[原生主体、Hub、Channel 与授权](architecture/actor-collaboration.md)；人类与 Agent/Bot/Session 具备原生主体性，权限独立授予；属于目标设计，不代表多租户已实现。
- 存量会话的 Skills 目录刷新：[实现边界与验收标准](session-capability-refresh.md)；正文版本更新与 Hermes 自动热刷新已取消，Connector 按下列独立文档推进。
- 平台级 Connector：[机制、已实现链路与剩余范围](platform-connectors.md)；由平台运行时持有连接与授权状态。
- 跨端存储生命周期：[SQLite / IndexedDB 升级与恢复](sqlite-lifecycle.md)、[插件持久化契约](plugin-persistence.md)、[Host 通用文档 API](host-document-storage.md)；九个自有 Node SQLite 库已接入账本/备份/旧库处置，Host 五库启动期门控并投影健康摘要；回退只回退代码，不自动恢复备份，不承诺 N-1 兼容，不引入 Drizzle。
- Chat 与浏览器 Workbench：[Chat 架构专题索引](chat-ui-architecture.md)、[浏览器 Workbench](browser-workbench-architecture.md)。
- 执行所有权：[会话、运行实例与能力租约](execution-ownership.md)；明确创建提交、执行准入、断线撤销、释放及 warm 边界。
- Tasks 与看板：[领域模型](tasks-model.md) 与 [实现入口](../plugins/tasks/README.md)；两张业务表，同源列表/看板、多会话关联与独立活动状态，首版源码已实现。
- 构建目标：[构建矩阵](build-matrix.md) 与 [目标配置](../config/build-matrix.json)。
- iOS 手机端容器与手势：[Mobile shell](mobile-shell.md)；打包的 frontend Bot runtime 与原生通信：[Embedded Bot bridge](mobile-bot-bridge.md)；缓存与请求状态：[Mobile data architecture](mobile-data-architecture.md)。
- 行为验证架构：[Harness 设计纲领](architecture/harness.md)。
- 根目录与文件归属：[仓库布局](repository-layout.md)。

## 核心不变量

- GitHub 是目标核心上游，下游产品持有私有装配并消费固定版本；状态见 [迁移状态](upstream-transition.md)，不建立两套可写核心。
- 仓库根目录是独立 npm workspace，持有自己的 `package-lock.json`；公开核心的安装与检查不依赖父目录或私有产品工作区。
- AppServer 事件游标、投影状态和 durable history 的生命周期必须一致；Hermes 转译遵循 Hermes Desktop 语义，Chat Runtime 统一 Turn、queue、steer、工具活动和滚动所有权，各引擎适配保留其原生协议与能力边界。
- Web、Expo 与 Electron 共享领域模型和设计 token，但平台能力通过显式 adapter/port 接入，不能用平台条件分支破坏核心状态机。
- 下游产品工作区中的机械生成过渡兼容层由该产品持有，源码所有权在其前端服务；生成目录禁止手改。

## 变更边界

共享核心能力通过本仓库的正常 PR 演进；下游产品消费固定源码版本，并持有自己的身份、品牌、企业服务和部署装配。产品工作区中的生成兼容层由产品维护，在产品仓库执行生成与漂移检查；不是公开核心的前置依赖。边界与升级要求见 [上游与下游消费](upstream-transition.md)。

贡献 PR 执行安装、校验和构建，不部署下游产品。公共包发布走独立的 [精确制品发布流程](web-deployment.md#公共-npm-发布流程)；构建通过不代表已经发布。

## 验证

在仓库根目录运行：

```bash
npm ci
npm run gate
```

下游产品工作区的 Console 同步与原探针在产品目录运行显式命令，不是独立核心的前置依赖。

按实际改动选择相邻类型检查、聚焦测试及受影响的两端验证，具体范围见 [贡献指南](../CONTRIBUTING.md#develop-and-validate) 与 [构建矩阵](build-matrix.md)。客户端行为变化还需相关平台的真实运行证据；不以单元测试替代完整平台验收。
# 任务工作区设计

OpenCraft 工作区的所有权、呈现策略、不变量及验证账本见 [design/](../design/README.md)。
