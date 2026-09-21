# Computer 产品边界收口设计

日期：2026-08-02

## 1. 已批准目标

用户侧继续使用 `Computer` 作为一级产品概念。Computer 表示承载 Agent Runtime 的运行
机器，不改名为“运行设备”，也不从导航和 Agent 绑定关系中隐藏。

本轮只完成以下收口：

1. Computer 保持“一条安装命令完成下载、验签、接入和用户级常驻启动”；
2. Human 产品界面和普通 CLI 不要求用户理解腾讯云、TAT、Region、provider、PTY、
   managed/CVM/Lighthouse、Enrollment 或底层注册码；
3. Human 只看到 Computer 名称、操作系统、连接状态、安装命令、终端和 Agent 绑定；
4. Agent 继续采用“创建、部署、启动、停止、重启”的显式分步流程，本轮不实现“创建并
   启动”，也不改变现有 Agent 生命周期原子语义。

内部数据库、TDSQL shardkey、OpenAPI 内部契约、腾讯云 adapter、TAT FFI、Region 路由和
运行状态字段不重命名。产品隔离发生在 Human DTO、Web/Expo 文案和普通 CLI 边界。

## 2. 用户流程

### 2.1 Computer 接入

1. Owner/Admin 进入 `Computer` 页面；
2. 输入 Computer 名称并创建；
3. 点击“生成安装命令”；
4. 页面提示“在这台电脑的终端中运行以下命令”，并展示一次性命令和过期时间；
5. 命令在当前 macOS 用户下完成下载、完整性验证、接入和 LaunchAgent 启动；
6. 页面状态从“等待连接”收敛为“在线”，失败时显示“连接失败”。

用户不选择 Region，不接触 Human Access Token 文件、TAT 注册码、云账号或云密钥。安装
过程不使用 `sudo`，不要求管理员权限。

### 2.2 Agent 生命周期

新建 Agent 仍要求显示名、handle、Runtime、回复策略和可选 Computer 绑定。创建成功后
不自动部署、不自动启动。详情页保留“部署、启动、停止、重启”四个明确动作，由后台按
现有幂等生命周期语义执行。

本轮只清理这些动作周围的云厂商实现文案，不合并动作、不新增向导、不改变凭证轮换和
Computer assignment 的正确性约束。

## 3. 产品词汇

| 内部词汇 | Human 产品表达 |
|---|---|
| Computer | Computer |
| provisioning / unknown | 等待连接 |
| provider online | 在线 |
| provider offline | 离线 |
| provider error | 连接失败 |
| registration script / setup command | 安装命令 |
| TAT PTY | 终端 |
| Tencent IM | 消息服务 |
| Enrollment token | 一次性接入凭证 |
| Region / managed / CVM / Lighthouse | 不展示 |

`Agent`、`Runtime`、`Server`、`Computer` 属于批准的产品名词，可以继续显示。代码、内部
日志和管理员诊断可以保留真实 provider 名称，但不得直接作为普通页面错误文本返回。

## 4. 改动边界

### 4.1 Web / Expo

- Computer 导航、页面标题和 Agent 绑定字段继续使用 `Computer`；
- Computer 创建表单只提交名称；详情只展示系统、产品化连接状态、最近连接时间和绑定的
  Agent；
- “打开 PTY 终端”改为“打开终端”，终端标题和无障碍标签不出现 `TAT` 或 `PTY`；
- 登录、首次 Server、消息搜索、消息连接错误等普通文案使用“消息服务”或中性表达；
- 不展示原始 Region、TAT 状态、实例类型和 provider operation 名称；
- 现有 Agent 创建与四个生命周期按钮保持不变，并由回归测试固定。

### 4.2 Computer CLI

- 根帮助只描述“Computer 运行服务”，不提腾讯云或 TAT；
- 正常用户只需执行平台生成的一行安装命令，不需要手写 CLI 参数；
- `run`、`install`、`daemon` 是安装器/开发/内部入口，可继续兼容调用，但从普通命令列表
  隐藏；其帮助文本采用“平台、接入凭证、状态目录”等中性术语；
- 二进制名、内部目录名和序列化字段不为文案收口而迁移。

### 4.3 后台与协议

- Human OpenAPI 的 Computer DTO 继续使用现有 allowlist，不增加 Region、TAT 或 provider
  字段；
- `computer-bootstrap.openapi.yaml` 继续保留真实兼容字段，只供 Computer 使用；
- Human 错误只返回稳定产品错误；真实 provider 错误写入受控诊断日志，不直接透传；
- 不修改数据库表、分片键、Computer credential、Agent credential 或生命周期状态机。

## 5. 测试与验收

采用测试先行：

1. Web 文案测试先证明登录页、Computer、终端和消息搜索仍泄漏被禁词，再修改实现；
2. CLI 帮助测试先证明根帮助和普通命令列表仍泄漏内部入口/厂商词，再修改实现；
3. Agent 页面测试固定“创建 Agent 不自动启动”和四个分步动作仍存在；
4. Computer 页面测试固定只提交名称、可生成一键安装命令、产品状态映射和终端中性文案；
5. 增加产品边界扫描，只扫描 Human UI 与普通 CLI 输出，不扫描 provider adapter、内部协议
   或第三方 SDK；
6. 运行 Expo 定向及全量测试、Go 定向及全量测试、race/vet、生成一致性和凭证扫描；
7. 重新构建 Expo Web 并嵌入 Chatserver，验证嵌入资源与最新构建一致，避免部署旧 bundle。

线上发布不在本轮默认授权范围内。完成本地构建和验收后，单独报告待部署产物，由用户明确
要求后再滚动 Canary。

## 6. 非目标

- 不把 Computer 改名为“运行设备”或“电脑”；
- 不实现 Agent 一键创建、一键部署或创建后自动启动；
- 不删除内部腾讯云/TAT/Region 模型；
- 不重写终端协议，不改变客户端直连消息服务的架构；
- 不新增数据库表、迁移、分片策略或长期状态；
- 不在本轮修改生产 Kubernetes、TDSQL、腾讯云 IM/TAT/COS 配置。
