# LightVela Long-Form Style Guide

## Shared Style

Write like a product builder explaining something useful to a real user. The style is warm, clear, and practical, with enough narrative to make the article readable.

Default article length: 900-1,500 words unless the user gives a target length.

## Output Channel

Choose one output channel before writing:

- `social-media`: produce the article in chat unless the user asks to save it. Default language is English unless the user asks for Chinese or bilingual output.
- `techpedia`: for Tencent Techpedia、腾讯技术百科、开发者社区、开发者文章, produce Markdown files, not chat-only output. Always create one Chinese version and one English version.

If the user does not specify the channel, ask one short clarification question before drafting.

Use this shape:

```markdown
Article Title
[Image: Recommended hero image or product screenshot]
Opening paragraphs...

Section Heading
Body...
[Image: Recommended screenshot or diagram for this moment]

Section Heading
Body...

Done / What Comes Next / Why It Matters
Closing paragraphs...

Join LightVela's Community for More Updates!
Discord:
Join our Discord community — scan the QR code to connect with builders and get updates.
![LightVela Discord QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-discord-qr.png>)

WhatsApp:
Join our WhatsApp group — scan the QR code to try LightVela and chat with us directly.
![LightVela WhatsApp QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-whatsapp-qr.png>)
```

Voice rules:

- Use first person for use-case stories when appropriate: "I wanted...", "I connected...", "What I learned...".
- Use second person for tutorials: "You will...", "Make sure...", "Go back...".
- Use product voice for feature introductions: "LightVela gives...", "A Soul is...", "This lets...".
- Keep paragraphs short, usually 2-5 sentences.
- Prefer concrete nouns and verbs: connect, paste, install, ask, schedule, reply, verify.
- Use examples and short quoted prompts where the user needs to see exactly what to type.
- Keep the ending grounded: what the user can now do, why it matters, and what the pattern unlocks.
- Always append the Community Ending after the article's normal closing. The Discord and WhatsApp QR images are real assets, not `[Image]` placeholders.
- Use explicit image placeholders: `[Image: <what to add here>]`. Do not use a bare `[Image]`.
- Keep image density fair: usually 2-4 images for a long article, up to 5 only for a screenshot-heavy tutorial.

Avoid:

- SEO stuffing.
- Over-polished launch slogans.
- Long bullet lists unless the article is genuinely procedural.
- Claiming features that were not provided by the user or found in repo/docs.
- Saying "seamless", "revolutionary", "game-changing", or similar empty marketing terms.

## Community Ending

Append this exact ending after every complete article, regardless of whether the selected mode is `tutorial`, `feature-intro`, or `use-case`. Keep it after the article's own closing section, and do not replace the QR images with `[Image]` placeholders.

```markdown
Join LightVela's Community for More Updates!

Discord:
Join our Discord community — scan the QR code to connect with builders and get updates.

![LightVela Discord QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-discord-qr.png>)

WhatsApp:
Join our WhatsApp group — scan the QR code to try LightVela and chat with us directly.

![LightVela WhatsApp QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-whatsapp-qr.png>)
```

## Image Planning

Before finalizing, decide whether images improve the article. Prefer images that reduce reader effort:

- Hero or product state image near the top.
- Screenshot after a major UI milestone.
- Simple diagram for a workflow, lifecycle, or architecture explanation.
- Result screenshot near verification or outcome.

Do not overfill the article with images. If an image is recommended, mark the exact position in the article with `[Image: <specific recommendation>]`.

After the article is produced, also include a short chat summary:

```markdown
Image recommendations:
- After "<section heading>": <image to add> — <why>
- After "<section heading>": <image to add> — <why>
```

For `techpedia`, keep these image placeholders inside both `.zh.md` and `.en.md` files, and include the same image recommendation list in the final chat response.

## Techpedia / Developer Community Files

For Tencent Techpedia or 开发者社区 output:

- Create two Markdown files: `<slug>.zh.md` and `<slug>.en.md`.
- The Chinese version should be publication-ready Chinese, not a rough machine translation.
- The English version should follow the same structure, examples, and image placeholders.
- Include the Community Ending in both files.
- Report the saved paths in the final chat response.
- If the repository has no established content directory, use `product/longform-content/<yyyy-mm-dd>-<slug>.zh.md` and `product/longform-content/<yyyy-mm-dd>-<slug>.en.md`.

## Tutorial Series

Use for `LV 长篇内容（教程系列）`.

Purpose: help a user complete a concrete setup or workflow.

Recommended structure:

```markdown
<Outcome-focused title>
[Image: Hero screenshot showing the finished setup or target workflow]
Why this setup matters, what the guide will help the user do.

Before You Start
Prerequisites, accounts, tokens, model/channel/skill requirements, safety notes.

Step 1: <Action>
Clear instruction and product context.
[Image: Screenshot of the UI after completing this milestone]

Step 2: <Action>
Continue with exact clicks, fields, commands, or prompts.

Step 3: <Action>
...

Verify It Works
Tell the user what success looks like and what to ask Hermes.

If Something Goes Wrong
Common failure cases and practical fixes.

A Few Notes
Constraints, best practices, or edge cases.

Done
Short closing that restates the completed outcome.

Join LightVela's Community for More Updates!
Discord:
Join our Discord community — scan the QR code to connect with builders and get updates.
![LightVela Discord QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-discord-qr.png>)

WhatsApp:
Join our WhatsApp group — scan the QR code to try LightVela and chat with us directly.
![LightVela WhatsApp QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-whatsapp-qr.png>)
```

Style notes:

- Make the first paragraph immediately useful.
- Number steps only when the sequence matters.
- Include safety notes near the action that creates risk, such as tokens, API keys, permissions, or public channels.
- Add `[Image: <specific screenshot>]` after major UI milestones.
- Include short prompt examples in fenced code blocks when users should type something into Hermes.

## Feature Introduction Series

Use for `LV 长篇内容（功能介绍系列）`.

Purpose: introduce a product capability and explain why users should care.

Recommended structure:

```markdown
Introducing <feature>: <human benefit> with LightVela
[Image: Product screenshot or simple visual showing the feature]
Start from the existing LightVela/Hermes context and the user problem this feature answers.

What Is <Feature>?
Define the capability in simple product language.

Why It Matters
Explain the user need and what changes after the feature exists.
[Image: Before/after visual or user-facing state]

How It Works
Explain entry points, core actions, states, and result.
[Image: Screenshot or diagram of the workflow]

What You Can Do With It
Give 2-4 concrete examples in prose.

What Comes Next
Close with the product direction and what this first version unlocks.

Join LightVela's Community for More Updates!
Discord:
Join our Discord community — scan the QR code to connect with builders and get updates.
![LightVela Discord QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-discord-qr.png>)

WhatsApp:
Join our WhatsApp group — scan the QR code to try LightVela and chat with us directly.
![LightVela WhatsApp QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-whatsapp-qr.png>)
```

Style notes:

- Lead with the shift in user experience, not an internal implementation detail.
- Use "what Hermes can use" vs "how Hermes shows up" style contrasts when helpful.
- Avoid full step-by-step setup unless the feature intro needs a short "how to try it" section.
- Keep product definitions crisp: one feature, one job, one user-facing benefit.

## Use-Case Series

Use for `LV 长篇内容（应用场景系列）`.

Purpose: tell a specific story showing how LightVela turns Hermes into a useful always-on assistant.

Recommended structure:

```markdown
I made a <scenario> agent in <channel> with LightVela
[Image: Hero image showing the channel or finished assistant]
Open with a specific annoyance, recurring task, or personal need.

Starting With <Channel or Entry Point>
Why this channel/workflow fit the user's real behavior.
[Image: Screenshot of the channel or entry point]

Giving Hermes The Right Tools
Explain skills, model, memory, channel, or configuration used.
[Image: Screenshot of skills, model, memory, or configuration]

Turning It Into <Specific Assistant>
Show example prompts and what Hermes returns or helps with.

Automating The Assistant
If relevant, explain scheduled or repeated tasks with Automations.
[Image: Screenshot of the automation schedule or repeated result]

What I Learned
Extract the product pattern.

Why I Liked It
End emotionally but practically: what became easier, what stayed online, what felt personal.

Join LightVela's Community for More Updates!
Discord:
Join our Discord community — scan the QR code to connect with builders and get updates.
![LightVela Discord QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-discord-qr.png>)

WhatsApp:
Join our WhatsApp group — scan the QR code to try LightVela and chat with us directly.
![LightVela WhatsApp QR](</Users/cassidyshi/Documents/LightVela mono2/.agents/skills/lv-longform-content/assets/lightvela-whatsapp-qr.png>)
```

Style notes:

- Use a first-person narrative when the prompt is a scenario/story.
- Start from a small annoyance, not from the product.
- Make the build feel achievable: channel + skill + instruction + optional automation.
- Include transferable examples near the end: "The same pattern could work for..."
- Keep the article honest. If a skill or data source is hypothetical, phrase it as "you could" or "with the right skill".

## Quick Revision Checklist

Before finalizing, check:

- The selected mode matches the prompt.
- The output channel is known. If not, ask whether this is social media or Tencent Techpedia/开发者社区.
- The title matches the series style.
- The article begins with a narrative/product hook and `[Image: <specific recommendation>]`.
- Image placeholders appear at natural screenshot moments, with fair density.
- The final chat response lists all recommended image placements and what each image should show.
- For Techpedia/开发者社区, two Markdown files exist: Chinese and English.
- The Community Ending appears after the normal article closing, with both QR image links intact.
- The product mechanics are clear enough to act on.
- The piece sounds like LightVela/Hermes, not a generic AI SaaS blog.
- No attached example content is copied beyond structural inspiration.
