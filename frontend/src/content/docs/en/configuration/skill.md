# Configure Skills

Skills are additional capability packages callable by Hermes. They extend concrete task handling beyond basic conversation, such as automatically organizing to-dos, generating daily reports, browsing web pages, searching news, generating images, and more.

All skills come from [**Skills.sh**](https://skills.sh/) and [**ClawHub**](https://clawhub.ai/) — the skill marketplaces shared by OpenClaw and Hermes.

## This page covers

- Relationship between Hermes and skills

- Two installation methods: console installation and conversation installation

- Skill usage examples

- Deleting installed skills

- FAQ


> 💡 **Skills are optional**
> 
> Hermes does not install any skills by default. Hermes can still chat normally without installed skills. Skills are only used to extend specific task capabilities. We recommend installing them as needed after you discover capability boundaries during use.

---

## Positioning of skills

If Hermes combined with a large model gives users an intelligent AI assistant, skills are its "hands and feet". Skills can further extend the capability boundary of an already deployed Hermes.

You can think of skills as "applications" for Hermes:

- Basic conversation capability = operating system

- Skills = applications installed on demand


Each skill focuses on a single task, for example:

- Browsing web pages and querying information with a browser

- Automatically organizing daily to-dos

- Sending scheduled news briefings

- Generating images from descriptions

- Querying real-time stock and fund information

- Organizing chat records into structured notes


Hermes automatically determines whether to call the corresponding skill based on conversation context. Users do not need to specify it.

---

---

## Method 1: Install through the console panel (coming soon)

The LightVela console provides a visual skill configuration entry in the "Skills" button. You can enter a skill name found on Skills.sh or ClawHub and install it quickly.

### 1. Enter the LightVela console

Sign in to LightVela, click "My AI Partners" in the upper-right corner to enter the console, and find the "Skills" button.

### 2. Search and install

Enter the recorded skill name in the search box (such as `gmail`) and click the **+** button.

![](../images/clawhub-install-global-en.webp)

### 3. Confirm availability in conversation

Return to a connected channel (Telegram / WhatsApp / Discord / Slack / WeChat). First ask Hermes to update its skill list, then check the currently available skills:

```
Please update your skill list
```

```
What skills are currently available?
```

If the newly installed skill appears in the list, you can start using it in conversation.

---

## Method 2: Install directly through conversation

In addition to using the console panel, you can also ask Hermes to install a skill directly through conversation. The skill to install still needs to be listed on Skills.sh or ClawHub.

### 1. Confirm the conversation channel is available

First make sure Hermes is connected to at least one channel (Telegram / WhatsApp / Discord / Slack / WeChat) and can currently chat normally.

### 2. Tell Hermes which skill to install

Use the command below as a reference. Tell Hermes what skill you want to install and replace `[skill name]` with the actual name from Skills.sh or ClawHub:

```
Please install a skill from Skills.sh or ClawHub. Its name is [skill name]
```

For example, to install `mcd` (McDonald's assistant):

```
Please install a skill from Skills.sh or ClawHub. Its name is mcd
```

If everything goes well, Hermes will complete the installation directly and tell you the result.

> ⚠️ **Secondary confirmation for high-risk skills**
> 
> If the selected skill is marked as high-risk on Skills.sh or ClawHub (it may contain unsafe behavior), Hermes will remind you and request secondary confirmation before installation. Please make sure you fully understand the behavior of the skill before deciding whether to continue. If you are unsure, proceed with caution.

### 3. Verify the installation result

You can ask Hermes to show how to use the skill to verify that installation succeeded:

```
Please show me how to use it
```

Or specify the skill name explicitly:

```
Please show me how to use mcd
```

---

## Skill usage examples

Using the `agent-browser` browser-operation skill as an example, after installation you can ask Hermes to perform the following tasks.

> ℹ️ **Note**
> 
> The following examples use the WeChat channel. Telegram, WhatsApp, Discord, and Slack work the same way.

### Scenario 1: Browse a web page

```
Use the browser to visit Baidu and tell me what is on the page
```

Hermes opens the page and returns the content in text form.

### Scenario 2: Search information through the browser

```
Use the browser to look up today's top 5 trending news stories
```

### Scenario 3: Multi-step complex task

```
Use the browser to search ClawHub and find the currently most-installed email skill
```

This task includes multiple steps such as opening a web page, waiting for it to load, entering content, and clicking buttons. It is relatively complex. Hermes completes the steps and returns the result.

![](../images/clawhub-browser-example-global-en.webp)

---

## Delete installed skills

If you no longer use an installed skill, you can ask Hermes to delete it through conversation.

### 1. View currently installed skills

```
What skills do you currently have installed?
```

### 2. Request deletion of a specific skill

Find the skill you want to delete and send a deletion command:

```
Please delete the email skill
```

If everything goes well, Hermes will complete the deletion and tell you the result.

> ℹ️ **Possible secondary confirmation**
> 
> Depending on the model being used or Hermes's personality settings, it may remind you to be careful when deleting. Reply with confirmation according to your actual needs.

### 3. Verify the deletion result

Check the currently installed skills again and confirm the target skill has been removed from the list:

```
Check again what skills you currently have installed
```

> ℹ️ **Currently only conversation-based deletion is supported**
> 
> LightVela uses a cloud-hosted mode and does not provide user-facing file-system operations. Skills can only be deleted through conversation with Hermes.

---

## Success state

- The target skill appears in the "Installed skills" list in the console

- When you make a related request in conversation, Hermes can correctly recognize and call the skill

- The skill can be deleted normally through conversation


---

## Installation safety tips

Skills have permission to call Hermes capabilities at runtime and may involve:

- Calling external APIs (consuming the corresponding quota)

- Reading or sending conversation content

- Running scheduled operations

Before installation, confirm that the skill author is trustworthy. We recommend:

- Prefer officially verified skills on Skills.sh or ClawHub

- Prefer skills with high downloads and good reviews

- Carefully read the permission description in the skill description

- Stay cautious with skills that have unclear descriptions or unfamiliar authors


---

## FAQ

### Cannot find a skill

**Possible cause**: The name is misspelled, or the skill has been removed from Skills.sh or ClawHub.

**Solution**: Go to [**Skills.sh**](https://skills.sh/) or [**ClawHub**](https://clawhub.ai/) to confirm the exact skill name and current status.

### Installation succeeds but does not take effect in conversation

**Possible cause**: The model did not recognize that it should use the skill, or the skill list has not been refreshed.

**Solution**:

1. Send "Please update your skill list" in the conversation

2. Use a clearer instruction, such as "Use the XX skill to complete YY"


### Installation says "rate limit triggered, please try again later"

**Possible cause**: Skills.sh and ClawHub apply API rate limits to protect service stability.

**Solution**: Wait for a while and try again. We recommend avoiding peak hours.

### Skill calls keep failing

**Possible causes**:

- External services required by the skill are temporarily unavailable

- The skill version is outdated

- The corresponding model does not support the capabilities required by the skill, such as tool calling


**Solution**:

- Check the skill's comments and latest version information on Skills.sh or ClawHub

- Try switching to a model that supports tool calling

- If the issue persists, contact the skill author


### Too many installed skills make Hermes respond slowly

**Possible cause**: More skills increase the decision-making burden of the Agent.

**Solution**: Keep only commonly used skills and delete those you no longer use.

### How to develop skills

See Skills.sh and ClawHub developer documentation (if available).

---

## Next steps

LightVela basic configuration is complete. You can refer to:

- [Configuration Overview](../05-configuration.md)

- [Core Concepts](../04-core-concepts.md)

- [Quick Start](../02-quickstart.md)
