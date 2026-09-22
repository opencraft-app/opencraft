# Manage Bots

## Summary

**A Bot is an independent profile inside your Hermes Agent. The main Bot is created with the Agent, and each additional Bot can have its own model settings, persona, memory, Skills, channels, and scheduled tasks. When you create a Bot, choose whether to copy an existing Bot or start with Basic setup. Your plan determines how many Bots you can create, including the main Bot.**

> **Availability on the international site**
>
> Additional Bot creation is being introduced in stages. The **Create Bot** entry is not shown by default on the international site during this rollout. If the entry is unavailable, continue using the main Bot.

## This page covers

- The relationship between a Hermes Agent and its Bots.
- Creating a Bot by copying an existing Bot or using Basic setup.
- What each creation method inherits.
- Switching, renaming, and deleting Bots.

## Before you start

1. Confirm that your Hermes Agent is running.
2. Confirm that your plan has room for another Bot. The plan limit includes the main Bot.
3. Open **Agents** and select the Agent you want to manage.

## Create a Bot

When the creation entry is available:

1. Select **New Bot**.
2. Enter a Bot name of no more than 60 characters.
3. Choose a creation method.
4. Review the inheritance summary, then select **Confirm creation**.
5. Wait for the new Bot to finish provisioning before configuring or using it.

The available copy option depends on the Bot currently selected. From the main Bot, the console shows **Copy current (main Bot)**. From another Bot, you can choose **Clone current** or **Clone main Bot**.

## Choose a creation method

| Method | Inherited | Not inherited |
| --- | --- | --- |
| Copy current, Clone current, or Clone main Bot | Model, persona, Skills, user preferences, and long-term memory from the selected source Bot | Current conversation, chat history, scheduled tasks, runtime state, and channel connections |
| Basic setup | The main Bot's current primary model and its Provider credentials, plus built-in system Skills | Fallback models, other configured models, persona, memory, Skills installed later on the main Bot, channels, and scheduled tasks |

**Basic setup is not an empty Bot.** It keeps the minimum model and built-in Skill configuration needed to get started, while leaving personal behavior, memory, and integrations separate.

## Confirm the new Bot

After provisioning finishes:

1. Confirm that a new Bot tab appears with the name you entered.
2. Select the new Bot and check that its model and Skills match the creation method you chose.
3. Open the relevant configuration page before adding a [Soul](./personality.md), installing [Skills](./skill.md), connecting channels, or creating [Scheduled Tasks](./automation.md).

## Work with multiple Bots

Bot tabs appear at the top of the Agent console. Select a tab before changing model settings, persona, memory, Skills, channels, scheduled tasks, or diagnostics so that you are working with the intended Bot.

Each Bot has its own profile and data. Changes to one Bot do not automatically update the other Bots. The console **Chat** feature is currently available only for the main Bot, and Agent-level maintenance should also be performed from the main Bot.

To rename a Bot, select it and edit its displayed name. The new name can contain up to 60 characters.

## Delete a Bot

- Deleting an additional Bot permanently removes that Bot's profile and data.
- Disconnect a channel owned by that Bot before deleting it.
- Delete all additional Bots before deleting the main Bot.
- Deleting the main Bot deletes the entire Agent, including all chats, configuration, installed Skills, memories, and related data.

Deletion cannot be undone. Read the confirmation message carefully and enter the requested Bot name before confirming.

## Troubleshooting

### Why can't I create another Bot?

The creation entry may still be hidden during the international rollout, the multi-Bot capability may be unavailable for the current Agent version, the Agent may not be running, or your plan may have reached its Bot limit.

### Why is a copied Bot missing conversations, tasks, or channels?

These items are intentionally not copied. Reconnect channels and recreate scheduled tasks for the new Bot as needed.

### Why does Basic setup still show a model and Skills?

Basic setup inherits the main Bot's current primary model and Provider credentials and keeps only the built-in system Skills. It does not copy the main Bot's other models, persona, memory, later-installed Skills, channels, or scheduled tasks.
