<div align="center">

<img src="apps/workbench-web/public/opencraft-icon.svg" width="80" height="80" alt="OpenCraft 标志" />

# OpenCraft

### Everyone Agent Everywhere

**每个人的 Agent，连接每一个地方。**

接入运行在不同地方的 Agent，让你选择的人也能使用它们。

[English](README.md) · [简体中文](README.zh-CN.md)

[![构建](https://github.com/opencraft-app/opencraft/actions/workflows/build-matrix.yml/badge.svg)](https://github.com/opencraft-app/opencraft/actions/workflows/build-matrix.yml) [![安全检查](https://github.com/opencraft-app/opencraft/actions/workflows/security.yml/badge.svg)](https://github.com/opencraft-app/opencraft/actions/workflows/security.yml) [![许可证：Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-64748b)](LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://github.com/topics/typescript)

[![AI Agents](https://img.shields.io/badge/AI_Agents-18181b)](https://github.com/topics/ai-agents) [![ACP](https://img.shields.io/badge/ACP-18181b)](plugins/acp-engine/README.md) [![MCP](https://img.shields.io/badge/MCP-18181b)](docs/session-capabilities.md) [![自主部署](https://img.shields.io/badge/Self_Hosted-18181b)](docker/README.md) [![协作](https://img.shields.io/badge/Collaboration-18181b)](docs/actor-collaboration-api.md)

[快速开始](#快速开始) · [可以用来做什么](#可以用来做什么) · [文档导航](#文档导航) · [参与贡献](CONTRIBUTING.md)

</div>

## 我们的理念

OpenCraft 是一个开源 Agent 工作台，围绕 **Everyone Agent Everywhere** 构建。
你的 Agent 可以运行在自己的电脑、远程开发机，或自主部署的服务器上。
我们希望让这些 Agent 在一个共同的工作台中发挥作用，也让你能把它们开放给别人使用。

- **Everyone · 每个人**：每个人都应该能够拥有、使用和分享 Agent。
- **Agent · 你的智能伙伴**：接入已经在用的 Agent，配置自己的模型服务，或为自定义运行时开发适配。
- **Everywhere · 无处不在**：连接不同机器上的 Agent，通过浏览器、桌面或手机使用同一个工作台。

### 接入你的 Agent，把它的能力分享出去

1. **接入**：让 Agent 继续在原来的地方运行，由执行 Host 保管环境与凭据。
2. **授权**：选择可以协作的人或 Agent，明确开放哪些访问权限。
3. **协作**：通过对话和执行请求开展工作，保留清晰的归属与权限边界。

我们的愿景是：你接入的 Agent，都可以成为能分享给他人使用的能力。
它可以是你的个人编程助手、团队的专项 Agent，也可以是你运营的一项服务。
分享的是使用能力，接收者无需取得 Agent 的底层凭据。

## 可以用来做什么

| 能力 | OpenCraft 中的体验 |
| --- | --- |
| **接入已有 Agent** | 连接已安装的 Codex、Cursor，检查登录状态、发现原生模型，选择实际支持的推理档位与 Fast 设置；其他运行时通过对应适配器接入。 |
| **使用自己的模型服务** | 在模型设置中配置 API 端点与凭据，由执行 Host 持有凭据。 |
| **跨机器工作** | 连接本地与远程执行 Host，按所选 Host 管理工作目录、会话及保存的状态。 |
| **保持对话连续** | 恢复已支持的原生历史、保留草稿、查看工具活动与已上报的 Token 用量，在一个工作台里发送任务或停止执行。 |
| **构建协作流程** | 使用经过认证的主体消息、接收／已读回执与显式授权；当前单 Hub 执行桥接支持绑定的本地 Codex 会话。 |
| **扩展工作台** | 通过现有扩展边界接入客户端插件、MCP 工具与 Host 侧能力。 |
| **选择使用方式** | 使用浏览器或 Electron 桌面端；公开 Expo 应用在手机端打包复用同一套 Web 工作台。 |

**当前范围。** 每种适配器只提供实际接通的能力。首期主体协作闭环位于单个 Hub；
跨 Hub 分享 Agent、任意 Agent 的通用即插即用接入，是我们推进的方向。
已实现能力及具体范围见[主体协作接口](docs/actor-collaboration-api.md)、
[主体与 Hub 设计](docs/architecture/actor-collaboration.md)和[执行契约](docs/execution-ownership.md)。

## 快速开始

使用 **Node.js 26.7.0** 和 **npm 11**，仓库通过 [`.nvmrc`](.nvmrc) 固定 Node 版本。

```bash
git clone https://github.com/opencraft-app/opencraft.git
cd opencraft
nvm install && nvm use
npm ci
npm run dev
```

打开终端打印的网址，连接已安装的 **Codex** 或 **Cursor**，
也可以在设置中配置自己的模型服务。本地开发无需 OpenCraft 账号。

`npm run dev` 会同时启动本地执行服务和 Web。开发数据保存在
`~/.opencraft/dev-local`，模型凭据由执行 Host 保管。

| 接下来想做什么 | 从这里开始 |
| --- | --- |
| 使用 Docker Compose 部署 | [Docker 部署指南](docker/README.md) |
| 安装或管理自主部署的网站 | [Web 部署与更新](docs/web-deployment.md) |
| 开发或打包桌面应用 | [开发指南](docs/development.md#desktop-with-the-bundled-local-agent) |
| 运行 Expo 或构建手机端 | [手机端指南](apps/mobile/README.md) |
| 配置 Host 或自定义构建 | [开发与构建指南](docs/development.md) |

## 文档导航

| 想了解 | 相关文档 |
| --- | --- |
| 项目全貌 | [文档索引](docs/README.md) · [仓库布局](docs/repository-layout.md) |
| Agent 身份、权限与协作 | [主体与 Hub 设计](docs/architecture/actor-collaboration.md) · [主体协作接口](docs/actor-collaboration-api.md) · [服务器登录](docs/server-authentication.md) |
| 执行与能力接入 | [执行所有权](docs/execution-ownership.md) · [会话能力](docs/session-capabilities.md) · [插件架构](docs/plugin-architecture.md) |
| 开发扩展 | [扩展开发指南](docs/extension-development.md) · [可运行示例](examples/extensions/README.md) |
| 架构与设计 | [平台架构](docs/platform-architecture.md) · [界面设计](design.md) · [构建矩阵](docs/build-matrix.md) |

## 一起建设

让更多 Agent 被连接，让更多人用上它们。
欢迎贡献 Agent 适配、协作能力、客户端体验、文档与示例。

- [反馈问题或提出想法](https://github.com/opencraft-app/opencraft/issues)。
- 修改共享核心前，阅读[贡献指南](CONTRIBUTING.md)。
- 产品专用身份、品牌和服务通过[下游装配](docs/upstream-transition.md)接入。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 中的流程私密报告。

## 开源许可

OpenCraft 原创贡献采用 [Apache-2.0](LICENSE) 许可。
第三方组件保留各自的许可证与必要声明。

<div align="center">

**Everyone Agent Everywhere**<br />
接入你拥有的 Agent，分享它能做到的事。

</div>
