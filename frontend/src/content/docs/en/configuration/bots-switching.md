# Bots Switching

## Summary

**Bots Switching lets one LightVela cloud Agent contain multiple specialized Bots. You can create Bots for research, planning, coding, content, support, or recurring workflows, then switch between them from the Bot avatar bar.**

**Each Bot has its own workspace context. Depending on whether you create a blank Bot or clone an existing Bot, LightVela applies different inheritance rules to model settings, memory, skills, personality, scheduled tasks, and channel connections.**

## Before you start

- Sign in to LightVela and open an active cloud Agent.
- To create an additional Bot, make sure your current plan allows another Bot and that no other Bot is still being created or deleted.
- If you plan to connect a channel, prepare the credentials or authorization method required by that channel.

## Creating your bot

After signing in with Google or GitHub and activating an available plan, open the [Agent console](/agents/overview/). Complete the first Bot setup: enter a required name, optionally add a description, and adjust its appearance. Select **Create** and wait for creation and initial configuration to finish. Select **Start your journey** once configuration finishes, then open Web Chat for that Bot. A messaging channel is optional; available plan model credits or a configured model are required for replies.

To create another Bot, select **New Bot** when the entry is available and your plan has capacity. Enter **Name** (required) and **Description** (optional), and adjust the appearance if needed. The default is **Basic setup**. If valid existing Bots can be copied, expand **Advanced** and select a specific source Bot. To copy the Bot you are using, open **Manage Bot → Copy Bot**; the creation form preselects that source. Review the source, then select **Create** and wait for completion.

The close control and advanced copy options are provided only when valid existing copy sources are available. The first setup without a source must be completed. Appearance controls let you change color, shape, and accessories; they do not choose the copy source.

The screenshots below show the current additional-Bot creation form and recommended templates. The close control and Advanced section are available because this Agent already has Bots; this is not the first-Bot setup screen.

![LightVela Bot creation form with an avatar selector, name field, description field, and Create button](../../images/bots-switching-create.webp)

![LightVela Bot creation templates including Health Steward, Market Analyst, and Industry Researcher](../../images/bots-switching-templates.webp)

## Bot workspace and settings

Select the intended Bot’s avatar in the Bot bar. On narrow screens, first expand the navigation panel. Confirm its name before changing models, memory, skills, channels, or scheduled tasks. Web Chat and its conversation list belong to the selected Bot; additional Bots can use Web Chat too. Connecting a messaging channel is not required for Web Chat.

![LightVela Bot avatar bar beside Channels, Skills, and Scheduled Tasks navigation](../../images/bots-switching-overview.webp)

The creation mode determines what the new Bot inherits:

| Creation mode | Inherited | Starts separately |
| --- | --- | --- |
| Basic setup | The primary model and its provider credentials, plus system-provided skills | Backup models, other configured models, personality, memory, skills installed later on the main Bot, channels, and scheduled tasks |
| Copy Bot | Models, personality, skills, user preferences, and long-term memory | Current conversation, previous chat history, scheduled tasks, runtime state, and channel connections |

Review the creation dialog before confirming if you need to keep settings separate. You can then manage each Bot's [memory](./memory.md), [skills](./skill.md), and [scheduled tasks](./automation.md) independently.

## Why build the Bots independently?

One Bot can handle many tasks, but its context becomes harder to manage as its responsibilities grow. A dedicated researcher, travel planner, financial analyst, or quality checker can keep a more focused set of memories, skills, personality settings, and scheduled tasks.

Independent Bots also make it easier to test a different working style without changing the Bot you already use for another task.

![LightVela Bot avatar bar with two Bots and the New Bot control](../../images/bots-switching-selector.webp)

Select the intended Bot’s avatar in the Bot bar. On narrow screens, first expand the navigation panel. Confirm its name before changing models, memory, skills, channels, or scheduled tasks. Web Chat and its conversation list belong to the selected Bot; additional Bots can use Web Chat too. Connecting a messaging channel is not required for Web Chat.

## How to use multiple Bots at once

You can connect multiple Bots to supported messaging channels. The available channel combinations depend on the LightVela region:

| LightVela version | Channels that support multiple Bot integration |
| --- | --- |
| Global version | Telegram, Discord, Slack, QQ, WeCom, Lark |

For channels such as WeChat and WhatsApp, the current configuration may allow only one Bot per instance. If a channel is already owned by another Bot, LightVela displays a notice and provides a way to manage the Bot that owns it.


## Verify a Bot switch or channel connection

After switching or connecting a Bot, check the following:

1. The active Bot name and avatar change to the Bot you selected.
2. The settings page shows the selected Bot's workspace and configuration.
3. A connected channel is listed under the Bot that owns the connection.
4. A short test message reaches the intended Bot and returns a reply.

For a group channel, send a test message with the permission level you configured. Confirm whether the Bot can only read the group context or can also reply.

## Common issues

| Issue | Likely cause | What to do |
| --- | --- | --- |
| **New Bot** is unavailable | Your plan has reached its Bot limit, or another Bot is still being created or deleted | Wait for the current operation to finish, delete an unused Bot, or upgrade to a plan with a higher limit |
| A clone option is unavailable | There is no valid current or main Bot to copy | Choose **Basic setup**, or return to the intended Bot before opening the creation dialog |
| The Bot list is temporarily unavailable | The Agent instance is stopped or the Bot list request failed | Start or refresh the Agent, then reload the Bot settings page |
| A channel is already connected to another Bot | The channel has a single-Bot ownership restriction | Use the notice to open the owning Bot, or disconnect and reconnect the channel according to the channel configuration page |
| A group message receives no reply | The Bot's group permission or channel configuration is incomplete | Review the relevant [Telegram](./channel-telegram.md), [Discord](./channel-discord.md), or other channel configuration page, then send another test message |

## Chatting with your Bots in groups

You can invite multiple Bots into supported group chats. Depending on the permission level you set, a Bot may read the group context, reply to user enquiries, or do both.

Group behavior and setup steps vary by platform. Follow the relevant channel configuration page before inviting the Bot, and test the Bot with a direct mention or another platform-supported trigger where required.
