# LightVela Long-Form Style Guide

## Shared Style

Write like a product builder explaining something useful to a real user. The style is warm, clear, and practical, with enough narrative to make the article readable.

Default article length: 900-1,500 words unless the user gives a target length.

Use this shape:

```markdown
Article Title
[Image]
Opening paragraphs...

Section Heading
Body...
[Image]

Section Heading
Body...

Done / What Comes Next / Why It Matters
Closing paragraphs...
```

Voice rules:

- Use first person for use-case stories when appropriate: "I wanted...", "I connected...", "What I learned...".
- Use second person for tutorials: "You will...", "Make sure...", "Go back...".
- Use product voice for feature introductions: "LightVela gives...", "A Soul is...", "This lets...".
- Keep paragraphs short, usually 2-5 sentences.
- Prefer concrete nouns and verbs: connect, paste, install, ask, schedule, reply, verify.
- Use examples and short quoted prompts where the user needs to see exactly what to type.
- Keep the ending grounded: what the user can now do, why it matters, and what the pattern unlocks.

Avoid:

- SEO stuffing.
- Over-polished launch slogans.
- Long bullet lists unless the article is genuinely procedural.
- Claiming features that were not provided by the user or found in repo/docs.
- Saying "seamless", "revolutionary", "game-changing", or similar empty marketing terms.

## Tutorial Series

Use for `LV 长篇内容（教程系列）`.

Purpose: help a user complete a concrete setup or workflow.

Recommended structure:

```markdown
<Outcome-focused title>
[Image]
Why this setup matters, what the guide will help the user do.

Before You Start
Prerequisites, accounts, tokens, model/channel/skill requirements, safety notes.

Step 1: <Action>
Clear instruction and product context.
[Image]

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
```

Style notes:

- Make the first paragraph immediately useful.
- Number steps only when the sequence matters.
- Include safety notes near the action that creates risk, such as tokens, API keys, permissions, or public channels.
- Add `[Image]` after major UI milestones.
- Include short prompt examples in fenced code blocks when users should type something into Hermes.

## Feature Introduction Series

Use for `LV 长篇内容（功能介绍系列）`.

Purpose: introduce a product capability and explain why users should care.

Recommended structure:

```markdown
Introducing <feature>: <human benefit> with LightVela
[Image]
Start from the existing LightVela/Hermes context and the user problem this feature answers.

What Is <Feature>?
Define the capability in simple product language.

Why It Matters
Explain the user need and what changes after the feature exists.
[Image]

How It Works
Explain entry points, core actions, states, and result.
[Image]

What You Can Do With It
Give 2-4 concrete examples in prose.

What Comes Next
Close with the product direction and what this first version unlocks.
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
[Image]
Open with a specific annoyance, recurring task, or personal need.

Starting With <Channel or Entry Point>
Why this channel/workflow fit the user's real behavior.
[Image]

Giving Hermes The Right Tools
Explain skills, model, memory, channel, or configuration used.
[Image]

Turning It Into <Specific Assistant>
Show example prompts and what Hermes returns or helps with.

Automating The Assistant
If relevant, explain scheduled or repeated tasks with Automations.
[Image]

What I Learned
Extract the product pattern.

Why I Liked It
End emotionally but practically: what became easier, what stayed online, what felt personal.
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
- The title matches the series style.
- The article begins with a narrative/product hook and `[Image]`.
- Image placeholders appear at natural screenshot moments.
- The product mechanics are clear enough to act on.
- The piece sounds like LightVela/Hermes, not a generic AI SaaS blog.
- No attached example content is copied beyond structural inspiration.
