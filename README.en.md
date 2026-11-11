<div align="center">

<img src="apps/workbench-web/public/opencraft-icon.svg" width="80" height="80" alt="OpenCraft logo" />

# OpenCraft

### Everyone Agent Everywhere

**Connect your agents. Share what they can do.**

Connect the agents you run, wherever they live, and make them available to the people you choose.

[简体中文](README.md) · [English](README.en.md)

[![Build](https://github.com/opencraft-app/opencraft/actions/workflows/build-matrix.yml/badge.svg)](https://github.com/opencraft-app/opencraft/actions/workflows/build-matrix.yml) [![Security](https://github.com/opencraft-app/opencraft/actions/workflows/security.yml/badge.svg)](https://github.com/opencraft-app/opencraft/actions/workflows/security.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-64748b)](LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://github.com/topics/typescript)

[![AI Agents](https://img.shields.io/badge/AI_Agents-18181b)](https://github.com/topics/ai-agents) [![ACP](https://img.shields.io/badge/ACP-18181b)](plugins/acp-engine/README.md) [![MCP](https://img.shields.io/badge/MCP-18181b)](docs/session-capabilities.md) [![Self Hosted](https://img.shields.io/badge/Self_Hosted-18181b)](docker/README.md) [![Collaboration](https://img.shields.io/badge/Collaboration-18181b)](docs/actor-collaboration-api.md)

[Get started](#get-started) · [What you can do](#what-you-can-do) · [Documentation](#documentation) · [Contribute](CONTRIBUTING.md)

</div>

## The idea

OpenCraft is an open-source Agent workbench built around **Everyone Agent Everywhere**.
An Agent might run on your laptop, a remote development machine, or a server you manage.
Our goal is to give those agents a common place to work—and let you share access to them with other people.

- **Everyone** — Everyone should be able to own, use and share an Agent.
- **Agent** — Bring your existing agents, connect your model providers, or build an integration for your own runtime.
- **Everywhere** — Reach agents across machines and use the workbench from the browser, desktop or mobile.

### Connect yours. Share its capabilities.

1. **Connect** an Agent where it already runs, keeping its environment and credentials with its execution Host.
2. **Authorize** the people or agents you want to work with, choosing the access you grant.
3. **Collaborate** through conversations and execution requests, with ownership and permissions kept explicit.

The vision is broad: an Agent you connect should be something you can offer to others,
whether it is your personal coding assistant, a team's specialist, or a service you operate.
Sharing means granting access to its capabilities; recipients do not need to inherit its credentials.

## What you can do

| Capability | In OpenCraft |
| --- | --- |
| **Bring an existing Agent** | Connect installed Codex and Cursor agents, check sign-in, discover native models, and select supported reasoning and Fast settings. Other runtimes connect through their adapters. |
| **Use your model providers** | Configure API endpoints and credentials through model settings. The execution Host owns the credentials. |
| **Work across machines** | Connect local and remote execution Hosts, with workspaces, conversations and saved state scoped to the selected Host. |
| **Keep conversations continuous** | Restore supported native history, keep drafts, inspect tool activity and reported token usage, and send or stop work from one workbench. |
| **Build collaboration** | Use authenticated Actor messaging, delivery/read receipts and explicit grants. The current single-Hub execution bridge supports bound local Codex sessions. |
| **Extend the workbench** | Add client extensions, MCP tools and Host-side capabilities through their existing integration boundaries. |
| **Choose your client** | Use the browser or Electron desktop app; the public Expo app packages the shared Web Workbench for mobile. |

**Current scope.** Each adapter exposes its actual capabilities. The first Actor collaboration loop
is single-Hub. Broader cross-Hub Agent sharing and a universal plug-and-play bridge for every Agent
remain development goals. See the [implemented collaboration API](docs/actor-collaboration-api.md),
[identity and Hub design](docs/architecture/actor-collaboration.md), and
[execution contracts](docs/execution-ownership.md).

## Get started

Use **Node.js 26.7.0** and **npm 11**. The repository pins Node in [`.nvmrc`](.nvmrc).

```bash
git clone https://github.com/opencraft-app/opencraft.git
cd opencraft
nvm install && nvm use
npm ci
npm run dev
```

Open the printed URL. Connect an installed **Codex** or **Cursor** agent,
or configure a model provider in Settings. Local development requires no OpenCraft account.

`npm run dev` starts local execution and Web together. Development data persists in
`~/.opencraft/dev-local`; model credentials stay with the execution Host.

| Your next step | Start here |
| --- | --- |
| Run with Docker Compose | [Docker deployment](docker/README.md) |
| Install or manage a self-hosted website | [Web deployment and updates](docs/web-deployment.md) |
| Develop or package the desktop app | [Development guide](docs/development.md#desktop-with-the-bundled-local-agent) |
| Run Expo or build for mobile | [Mobile guide](apps/mobile/README.md) |
| Connect Hosts or customize a build | [Development and build guide](docs/development.md) |

## Documentation

| For | Read |
| --- | --- |
| A tour of the project | [Documentation index](docs/README.md) · [Repository layout](docs/repository-layout.md) |
| Agent identity, access and collaboration | [Actor and Hub design](docs/architecture/actor-collaboration.md) · [Collaboration API](docs/actor-collaboration-api.md) · [Server authentication](docs/server-authentication.md) |
| Execution and integration | [Execution ownership](docs/execution-ownership.md) · [Session capabilities](docs/session-capabilities.md) · [Plugin architecture](docs/plugin-architecture.md) |
| Building an extension | [Extension development](docs/extension-development.md) · [Runnable example](examples/extensions/README.md) |
| Architecture and design | [Platform architecture](docs/platform-architecture.md) · [Interface design](design.md) · [Build matrix](docs/build-matrix.md) |

## Build with us

Help make more agents reachable and useful to more people.
Contributions to adapters, collaboration, client experiences, documentation and examples are welcome.

- [Report a problem or propose an idea](https://github.com/opencraft-app/opencraft/issues).
- Follow the [contribution guide](CONTRIBUTING.md) for changes to the shared core.
- Build product-specific identity, branding and services through [downstream composition](docs/upstream-transition.md).
- Report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

## License

Original OpenCraft contributions are licensed under [Apache-2.0](LICENSE).
Third-party components retain their own licenses and required notices.

<div align="center">

**Everyone Agent Everywhere**<br />
Connect what you run. Share what it can do.

</div>
