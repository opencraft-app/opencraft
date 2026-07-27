# LightVela vs Selfhost Agent: Which is best?

![LightVela cloud setup compared with running Hermes locally](../images/lightvela-vs-self-hosted-hermes.png)

**LightVela is the better fit when you want an always-on Hermes Agent without maintaining the computer underneath it.** Running Hermes on your own computer is the better choice when you want hands-on control over the runtime, tools, updates, and local environment. The right answer depends on whether you want to operate the setup or simply use the agent.

Hermes can run locally on macOS, Windows, Linux, WSL2, and more. Its official installer sets up the runtime and then lets you choose a model provider, tools, and messaging gateway yourself. The [Hermes installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation) makes that route quite approachable.

> **Approachable is not the same as invisible.** A local agent gives you control, but it also gives you responsibility for keeping the environment ready.

## At a glance

| What matters to you | Run Hermes on your computer | Use LightVela |
| - | - | - |
| **Where Hermes runs** | Your own machine | A dedicated cloud runtime |
| **Day-to-day control** | You choose the local setup and environment | You manage the agent through a hosted console |
| **Availability** | You keep the computer and process available | Designed to stay online independently of your local device |
| **Setup responsibility** | You configure the runtime, model, tools, and channels | The core agent environment is hosted for you |
| **Best fit** | Builders who enjoy owning the stack | People who want to use Hermes without operating the stack |

## What changes in everyday use

The local route is satisfying when you like knowing exactly where things live.

You install Hermes, choose a model provider, enable tools, and add a gateway when you want messaging access. Hermes’ own quickstart recommends getting one clean conversation working before layering on gateways, skills, voice, or routing—which is sensible advice for any self-managed setup. The [Hermes quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/) also shows that a local installation can grow into a bot or always-on workflow.

That flexibility is the point. You can experiment with your own environment, choose how updates happen, and build around the machine you already use.

The tradeoff appears later, in ordinary moments:

- **Availability:** Your computer needs to remain available for the agent to remain available.
- **Maintenance:** You are the person who notices when a model setting, tool, gateway, or update needs attention.
- **Scope:** “Just one more thing” can slowly turn a personal setup into something you maintain.

That is not a reason to avoid self-hosting. It is simply the job you are accepting.

## Where LightVela is the better fit

LightVela makes more sense when your goal is to have a Hermes Agent working for you, not to operate the machine underneath it.

LightVela runs a dedicated Hermes Agent instance in the cloud. The agent stays online independently of your local device, while you manage the practical parts—[models](https://lightvela.ai/docs/configuration/model), [channels](https://lightvela.ai/docs/configuration), and [skills](https://lightvela.ai/docs/configuration/skill)—from the console. The [LightVela overview](https://lightvela.ai/docs/overview) explains the hosted model, including isolated runtimes and multi-channel access.

That changes the feeling of using Hermes. You can connect the agent to the channel where you already talk—such as [Telegram](https://lightvela.ai/docs/configuration/channel-telegram), [WhatsApp](https://lightvela.ai/docs/configuration/channel-whatsapp), or [Discord](https://lightvela.ai/docs/configuration/channel-discord)—then keep using it even when your laptop is closed. You still make the meaningful choices, but you do not need to turn your personal computer into the place where availability is maintained.

For many people, the helpful distinction is simple:

> **LightVela gives you less setup to control. Self-hosting gives you more control over the setup.**

If you mainly want to configure your agent and get back to your work, the hosted console is usually the more comfortable starting point. You can still configure models, channels, and skills in one place through the [LightVela configuration overview](https://lightvela.ai/docs/configuration).

## Where running Hermes on your own computer is the better fit

Choose a local setup when building and controlling the runtime is part of the project—perhaps for a desktop workflow, home lab, or hands-on model experimentation.

You will own updates, credentials, and availability. “On my computer” also does not make every model, browser tool, or connected service local, so be precise about what you are controlling.

## Which should you choose?

Choose LightVela if:

- **You want availability:** You want Hermes ready without leaving your computer responsible for it.
- **You prefer configuration:** You would rather configure an agent than maintain its runtime.
- **You want one console:** You want a clear place to manage models, channels, and skills.
- **You already use messaging apps:** You want an always-on agent that fits into the channels you already use.

Choose Hermes on your own computer if:

- **You enjoy building:** You like terminal-first setup and hands-on experimentation.
- **You want ownership:** You want to tune the runtime around your personal environment.
- **You accept maintenance:** You are comfortable handling model configuration, updates, tools, and availability.

There is no need to pretend one answer is universally better. Start with the question underneath the question: **do I want to run infrastructure, or do I want an agent that is ready when I need it?**
