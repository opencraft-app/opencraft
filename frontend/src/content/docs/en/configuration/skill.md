# Configure Skills

Skills are additional capability packages callable by Hermes. They extend concrete task handling beyond basic conversation, such as automatically organizing to-dos, generating daily reports, browsing web pages, searching news, generating images, and more.

All skills come from [SkillHub](https://skillhub.tencent.com), an independent skill marketplace launched by Tencent.

## This page covers

- Introduction to SkillHub
    
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

## SkillHub

SkillHub is an independent skill marketplace launched by Tencent:

🔗 [https://skillhub.tencent.com](https://skillhub.tencent.com)

Features:

- Browse listed skills (with category, popularity, and rating filters)
    
- View skill descriptions, examples, and author information
    
- Record the skill name and install it in the LightVela console or through conversation
    

![](../images/20260424-151758-86pi.png)

> 💡 **Browse in SkillHub first, then install in LightVela**
> 
> LightVela installs skills by name. You need to confirm the exact target skill name in SkillHub first.

---

## Method 1: Install through the console panel (coming soon)

The LightVela console provides a visual skill configuration entry in the "Skill" button. You can enter the skill name found in SkillHub and install it quickly.

### 1. Confirm the target skill in SkillHub

Visit [https://skillhub.tencent.com](https://skillhub.tencent.com) and browse or search for the skill you need.

Using email as an example, find the `gmail` skill. It lets Hermes receive, send, and query emails. Record the skill name shown on the skill detail page (`gmail` in this example), which will be used for installation later.

![](../images/20260424-152040-78gn.png)

### 2. Enter the LightVela console

Sign in to LightVela, click "My Hermes" in the upper-right corner to enter the console, and find the "Skill" button.

### 3. Search and install

Enter the recorded skill name (such as `gmail`) in the search box and click the "**Install Skill**" button.

![](../images/7-1.png)

Wait a moment. After installation succeeds, the skill appears in the "Installed skills" list.


### 4. Confirm availability in conversation

Return to a connected channel (WeChat / Telegram / WhatsApp / Discord / Slack). First ask Hermes to update its skill list, then check the currently available skills:

```
Update your skill list
```

```
What skills are available now?
```

If the newly installed skill appears in the list, you can start using it in conversation.

---

## Method 2: Install directly through conversation

In addition to console panel operations, you can ask Hermes directly in conversation to install a skill. The skill must still be listed on SkillHub.

### 1. Confirm that a conversation channel is available

First make sure Hermes is connected to at least one channel (WeChat / Telegram / WhatsApp / Discord / Slack) and can currently chat normally.

### 2. Tell Hermes which skill to install

Use the following instruction and replace `[skill name]` with the actual name on SkillHub:

```
Help me install a skill from SkillHub. Its name is [skill name]
```

For example, install `mcd` (McDonald's assistant):

```
Help me install a skill from SkillHub. Its name is mcd
```

If everything works, Hermes installs it directly and reports the result.

> ⚠️ **Secondary confirmation for high-risk skills**
> 
> If the selected skill is marked as high-risk in SkillHub (it may contain unsafe behavior), Hermes will warn you and request secondary confirmation before installation. Continue only after you fully understand the skill behavior; if unsure, proceed cautiously.

### 3. Verify installation result

You can ask Hermes to view the skill usage guide to verify successful installation:

```
Help me check how to use it
```

Or specify the skill name explicitly:

```
Help me check how to use mcd
```

---

## Skill usage examples

Using the `agent-browser` browser operation skill on SkillHub as an example, after installation you can ask Hermes to perform the following tasks.

> ℹ️ **Note**
> 
> The following examples use the WeChat channel. Telegram, WhatsApp, Discord, and Slack work the same way.

### Scenario 1: Browse a web page

```
Use the browser to open example.com and summarize what is on the page
```

Hermes opens the page, reads the content, and returns it in text form.

### Scenario 2: Search information with the browser

```
Use the browser to look up today’s top 5 trending news stories
```

### Scenario 3: Multi-step complex task

```
Use the browser to search SkillHub and find which email-related skill currently has the most installs
```

This task includes multiple steps such as opening a web page, waiting for loading, entering content, and clicking buttons. It is relatively complex. Hermes completes the steps and returns the result.

![](../images/20260424-152321-dqwa.png)

---

## Delete installed skills

If there are installed skills you no longer use, you can ask Hermes to delete them through conversation.

### 1. View currently installed skills

```
Check which skills you currently have installed
```

### 2. Request deletion of a specific skill

Find the skill you want to delete and send a deletion instruction:

```
Please delete the email skill
```

If everything works, Hermes deletes it and reports the result.

> ℹ️ **Possible secondary confirmation**
> 
> Depending on the model used or Hermes personality settings, it may remind you to delete cautiously. Reply with confirmation according to your actual needs.

### 3. Verify deletion result

Check the currently installed skills again and confirm the target skill has been removed:

```
Check again which skills you currently have installed
```

> ℹ️ **Deletion currently supports conversation only**
> 
> LightVela uses a cloud-hosted model and does not provide a user-facing file system. Skill deletion is only supported through conversation with Hermes.

---

## Success state

- The console "Installed skills" list contains the target skill
    
- When related needs are raised in conversation, Hermes can correctly identify and call the skill
    
- The skill can be deleted normally through conversation
    

---

## Installation safety tips

> ⚠️ **Security check before installation**

Skills have permission to call Hermes capabilities at runtime and may involve:

- Calling external APIs (consuming corresponding quota)
    
- Reading or sending conversation content
    
- Running scheduled operations
    

Before installation, confirm that the skill author is trustworthy. Recommended checks:

- Prefer SkillHub officially verified skills
    
- Prefer skills with high downloads and good ratings
    
- Carefully read permission descriptions in the skill details
    
- Stay cautious with skills that have unclear descriptions or unfamiliar authors
    

---

## FAQ

### Cannot find a skill

**Possible cause**: The name is misspelled, or the skill has been removed from SkillHub.

**Solution**: Go to [SkillHub](https://skillhub.tencent.com) to confirm the exact skill name and current status.

### Installation succeeds but does not work in conversation

**Possible cause**: The model did not recognize that the skill should be used, or the skill list was not refreshed.

**Solution**:

1. Send "Update your skill list" in conversation
    
2. Use a clearer instruction, such as "Use XX skill to complete YY"
    

### Installation shows "trigger interface rate limited, please try again later"

**Possible cause**: SkillHub enforces API rate limits to protect service stability.

**Solution**: Wait for a while and try again. We recommend avoiding peak hours.

### Skill calls fail repeatedly

**Possible causes**:

- The external service required by the skill is temporarily unavailable
    
- The skill version is outdated
    
- The corresponding model does not support the capability required by the skill (such as tool calling)
    

**Solution**:

- Check the skill comments and latest version information in SkillHub
    
- Try switching to a model that supports tool calling
    
- If the issue persists, contact the skill author
    

### Too many installed skills make Hermes respond slowly

**Possible cause**: More skills increase the Agent's decision-making burden.

**Solution**: Keep only commonly used skills and delete skills that are no longer needed.

### How to develop skills

See SkillHub developer documentation if provided.

---

## Next steps

LightVela basic configuration is complete. You can refer to:

- [Configuration Overview](../05-configuration.md)
    
- [Core Concepts](../04-core-concepts.md)
    
- [Quickstart](../02-quickstart.md)
