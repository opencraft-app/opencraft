# DeepSeek Harness

## 摘要

**DeepSeek Harness 是一个插件优先的 AI Agent 框架，你可以在 LightVela 中将它与 Hermes Agent 并行安装。Labs 页面用于管理安装、运行状态、重启、WebUI 访问、支持的模型提供商密钥，以及包含 SkillHub 的配置档案，不会改变现有 Hermes 配置、通道、技能或记忆。关于 Hermes Agent 使用的模型提供商配置，请参阅[配置模型](./model.md)。**

![DeepSeek Harness 概览](../images/deepseek-harness-01.png)

提示：DeepSeek Harness 是处于早期体验阶段的 Labs 功能。
随着上游框架及其插件生态演进，后续更新可能带来兼容性变化。

## DeepSeek Harness 能带来什么

DeepSeek Harness（DSH）是一个开源 Agent 框架，为 AI 模型提供完成真实任务所需的环境和工具。
在 LightVela 中，DSH 作为 Hermes Agent 旁边独立的托管环境运行，你可以在其中处理项目文件、使用工具和技能、管理会话，并通过 WebUI 与 Agent 交互。

![Labs 中的 DeepSeek Harness 页面](../images/deepseek-harness-zh-02.png)

LightVela 为 DSH 提供托管入口。
你不需要手动安装软件包、配置公网服务地址，或从终端运行 DSH 服务。
在 Labs 中打开 DeepSeek Harness 页面后，你可以安装托管运行环境、检查运行状态、配置已批准的模型提供商、打开当前实例专属的 WebUI，并在需要时重启 DSH。

## 安装 DeepSeek Harness

1. 打开 [LightVela Agent 页面](https://lightvela.ai/agents/)。
2. 在左侧导航的 Labs 下选择 DeepSeek Harness。
3. 阅读 Beta 提示，然后选择立即安装体验。
4. 安装运行期间保持页面打开。
   正常安装通常需要约一到三分钟。

![安装 DeepSeek Harness](../images/deepseek-harness-zh-03.png)

## 配置模型提供商

安装 DeepSeek Harness 后，主 DSH 卡片下方会出现模型配置卡片。
国际站当前已批准的提供商列表包括：

- DeepSeek
- MiniMax
- MiniMax China
- Moonshot AI
- Moonshot AI China
- OpenRouter
- Anthropic
- Groq
- OpenAI

添加提供商：

1. 从提供商列表中选择一个提供商。
2. 将 API 密钥粘贴到 API 密钥输入框。
3. 选择保存。
4. 确认该提供商出现在已配置提供商列表中。

![DeepSeek Harness 模型提供商表单](../images/deepseek-harness-zh-04.png)

如需移除提供商，请选择删除操作并确认移除。
移除后，你可以稍后使用新的 API 密钥再次添加同一个提供商。

![已配置的 DeepSeek Harness 提供商](../images/deepseek-harness-zh-05.png)

## 打开 DeepSeek Harness WebUI

服务状态显示为运行中时，请在 DeepSeek Harness 卡片中选择访问 WebUI。

![访问 WebUI 按钮](../images/deepseek-harness-zh-06.png)

LightVela 为 DeepSeek Harness WebUI 提供专用访问域名和内置身份认证，确保 WebUI 只对你本人可访问。
完成认证后，你可以打开当前 Agent 实例的 WebUI，并使用已经配置的提供商进行简单测试。
如果你需要单独测试现有的 Hermes Agent，请使用[聊天](./agent-chat.md)。

![DeepSeek Harness WebUI](../images/deepseek-harness-zh-07.png)

## 了解插件

DeepSeek Harness 使用插件优先架构。
插件可以为 DSH 配置档案提供能力或集成，例如技能目录、消息连接器或其他运行时组件。
你可以点击 DSH 页面左下角的插件广场，访问 Plugin Plaza。

### 安装和使用插件

在 Plugin Plaza 中，你可以为 DeepSeek Harness 环境探索更多能力，例如浏览器工具、记忆、自动化、界面增强和外部集成。

![Plugin Plaza 搜索](../images/deepseek-harness-zh-08.png)

打开插件查看它提供的能力，然后安装需要使用的插件。
安装插件后，你可以直接在工作区中使用它，而不必在提示词中明确提及插件。
关于 LightVela 托管的 Hermes 技能，请参阅[配置技能](./skill.md)。

### 浏览已安装的插件

你可以在 DSH WebUI > Plugin Plaza > 已安装中查看插件列表。

![已安装的 DeepSeek Harness 插件](../images/deepseek-harness-zh-09.png)

## 使用工作区

工作区是 DeepSeek Harness 在会话期间使用的项目目录。
在 WebUI 中点击添加工作区图标，打开工作区目录。

![添加工作区图标](../images/deepseek-harness-zh-10.png)

选择后，你可以在云端托管的 DSH 环境中新建文件夹，或选择已有文件夹，将其设为项目工作区。
之后，Agent 可以使用工作区中的文件来理解项目、编辑文件、运行命令，并在这个云端工作区中执行任务。

![选择工作区目录对话框](../images/deepseek-harness-zh-11.png)

工作区也有助于整理项目和会话。
在工作区中创建的会话会与该目录关联，你可以回到同一个项目，继续使用相关的会话历史。
需要额外权限的操作仍受当前 DSH 权限策略约束，并可能要求你在 WebUI 中确认。
如需在 DSH 之外管理 LightVela 文件，请参阅[云存储](./files.md)。

## 重启 DeepSeek Harness

如果 DSH 已安装但需要在配置变更后重新加载，或需要从不健康状态恢复，请使用重启。
重启操作只作用于 DeepSeek Harness 服务。
Hermes Agent 会继续独立运行。

![重启 DeepSeek Harness 按钮](../images/deepseek-harness-zh-12.png)

## 常见问题

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| 安装未完成 | 托管安装任务未成功结束 | 查看页面上的错误信息，稍等片刻，然后从 DeepSeek Harness 页面重试。 |
| WebUI 无法打开 | 服务尚未就绪，或当前会话没有实例访问权限 | 确认 DSH 显示为运行中，然后在登录状态下从 Labs 页面重新打开 WebUI。 |
| 模型无法回答请求 | 没有配置提供商、密钥无效，或提供商账户不可用 | 检查已配置提供商列表，必要时更新 API 密钥，然后再次发送简单请求。 |
| 已保存的 API 密钥不可见 | 这是预期行为 | API 密钥只支持写入。保留已保存密钥时请留空，需要替换时输入新的密钥。 |
| 通道未连接 | 插件已经存在，但账号配置不完整 | 在 DSH WebUI 中完成通道配置和授权。 |
| 修改后 DSH 显示不健康 | 服务可能需要重新加载 | 使用重启，等待状态恢复为运行中，然后再次验证 WebUI 和提供商。 |

## 当前边界

LightVela 中的 DeepSeek Harness 是一个托管的 Labs 能力。
它提供安装、状态查看、重启、已批准的提供商凭证和受控的 WebUI 入口。

当前 Labs 页面不支持任意软件包安装、自定义插件上传、原始网络端口访问、自定义提供商端点、自定义提供商协议或高级模型参数编辑。
这些边界可以在功能处于 Beta 阶段时保持托管实例的可预测性。

如果你想体验插件式 Agent 环境、SkillHub 集成和支持的通道组件，同时不改变现有 Hermes Agent 设置，可以使用 DeepSeek Harness。

## 常见问题解答

### DeepSeek Harness 会替代 Hermes Agent 吗？

不会。
它会作为独立服务与 Hermes 并行运行。
现有 Hermes 的记忆、技能、通道和配置保持不变。

### 为什么看不到已保存的 API 密钥？

API 密钥只支持写入。
保留现有密钥时请留空，需要替换时输入新的密钥。

### 可以添加任意提供商、模型或自定义 Base URL 吗？

LightVela Labs 页面当前只支持选择器中显示的提供商。
如需额外的模型配置，包括自定义模型或 Base URL，你可以直接在 DeepSeek Harness WebUI 中管理。

### DeepSeek Harness 的技能和 Hermes 技能相同吗？

不相同。
DeepSeek Harness 和 Hermes Agent 是两个独立环境。
安装 DeepSeek Harness 不会自动将 Hermes 技能复制到 DSH，DSH 的插件或技能配置也不会改变 Hermes Agent 的设置。

### 为什么 DeepSeek Harness 标记为 Beta？

它是处于早期体验阶段的 Labs 功能。
DSH 或其插件的更新可能带来兼容性变化，因此请在更新后验证你的工作流。
