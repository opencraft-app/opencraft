# Vs Product / 竞品对比

Use for a practical comparison between LightVela and another product, or between LightVela and an alternative operating model such as self-hosting Hermes on a personal computer. The goal is to make a clear, evidence-backed case for LightVela while still naming the alternative's genuine best-fit scenario—not to stage a corporate takedown.

## Research and fairness

- Research both sides before drafting. Use current first-party documentation, pricing, product pages, release notes, or hands-on evidence. Date time-sensitive facts and link the source. Do not turn assumptions, marketing copy, or old reviews into claims.
- Compare the actual job the reader wants done: setup effort, day-to-day ownership, availability, control, privacy/data boundary, integrations, maintenance, and cost only when the evidence supports it.
- Treat LightVela as the lead recommendation when it fits the reader's stated job. Use a confident, user-centered advocacy tone: explain what LightVela makes easier or more reliable before discussing the alternative's tradeoffs.
- Give the alternative a genuine “best for” case, but do not flatten the article into neutral buyer-guide language. Do not call LightVela the universal winner, hide meaningful tradeoffs, or use dismissive competitor language.
- Keep the alternative section shorter and sharper than the LightVela section. Cover only the 2–4 competitor facts that change the reader's decision—usually its strongest fit, one meaningful tradeoff, and any decisive constraint. Do not write a full competitor profile, feature inventory, or equal-length marketing section.

## Shape and voice

Keep this mode tighter than a broad enterprise comparison: usually 800–1,100 words unless the user sets a length.

Use this title pattern for one-to-one comparisons:

```markdown
<Product A> vs <Product B>: Which is best to <specific job>?
```

Use plain `vs` without a period, name the actual job being compared, and avoid vague titles such as “Which product is better?”.

Suggested arc:

```markdown
<Product A vs Product B: Which is best to <specific job>?>
<One Codex-generated comparison hero image>

For `placement=external` / 站外, insert this language-matched Markdown block immediately after the title/hero and before the answer-first opening. Use the resolved `from` value for every LightVela link. Do not add this block for `placement=internal` / 站内 unless explicitly requested.

English:

```markdown
> **What is LightVela?** LightVela is a cloud-hosted personal AI agent platform for running an always-on agent with memory, skills, automations, and messaging channels. [Visit LightVela](https://lightvela.ai/?from=<attribution>)
```

Chinese:

```markdown
> **LightVela 是什么：** LightVela 是一个云端个人 AI Agent 平台，帮助用户运行具备长期记忆、Skills、自动化任务和多渠道接入能力的 Agent。[访问 LightVela](https://lightvela.ai/?from=<attribution>)
```

Answer-first: lead with when the reader should choose LightVela, then state the alternative's narrower best-fit case in 1–3 plain sentences. Lead with the reader's real constraint, not a company claim.

## At a glance
<A compact Markdown table with 4–6 decision-useful rows. Put LightVela in the first comparison column and frame the rows around the value of the reader's job.>

## What changes in everyday use
<Compare ownership and routine work with a concrete, ordinary scenario.>

## Where LightVela is the better fit
<Explain the relevant product advantage first, in plain language and backed by verified facts.>

## Where <alternative> is the better fit
<In a short section, give the strongest honest case for it and the most relevant limitation, after making LightVela's fit clear. Keep it materially shorter than the LightVela section.>

## Which should you choose?
<Use two short lists in this order: “Choose LightVela if…” followed by “Choose <alternative> if…”. Make the decision conditional, but let the evidence support LightVela where it matches the stated job.>
```

Write like a thoughtful builder talking to another builder: direct, specific, and human. Use a small, relatable tension in the opening, then move quickly to the decision. Prefer “if this is your setup…” over “best-in-class,” “enterprise-ready,” “revolutionary,” or similar corporate language.

## Hero image

Generate the first image with Codex `imagegen` for every `vs-product` article. It must be one clean 16:9 editorial comparison hero—never a `[RECOMMEND ADD IMAGE: ...]` placeholder. Always include `assets/vs-product-hero-reference.png` as the composition reference: preserve its soft lavender/pale-violet background, LightVela left half, exact straight center divider, sparse scale, and calm premium editorial composition. Change only the right half to fit the alternative. Text is optional; if used, keep it short, readable, and secondary rather than enforcing the industry template's headline placement.

For a side-by-side comparison, place LightVela on the **left** and the alternative on the **right**. When an official alternative icon/logo is available from that company's official site or a user-supplied asset, use it as a faithful reference on the right; otherwise use one obvious, unbranded physical metaphor for that alternative. For “host on your own computer,” replace the right-side icon with one clean personal laptop, showing only subtle abstract terminal marks. Make the comparison legible without turning it into a hostile logo battle. Recommend any later in-body images only when they make a specific decision easier.

Keep the composition deliberately sparse: one principal icon/object per side and, at most, one small supporting context object per side. Use a straight split divider or exactly one fixed-size circular marker at the visual center—never multiple floating circles or inconsistent circle sizes/shapes. Avoid decorative connection nodes, repeated badges, dense UI panels, extra server stacks, or visual elements that do not clarify the comparison.

When the visual includes LightVela, use `assets/lightvela-brand-icon.png` as the approved brand-icon reference. Preserve the recognizable mark and keep it modest on the LightVela side; do not alter it into a new mascot or use it as a competitor logo. See `references/brand-assets.md`.

Use a table only for concise comparisons; keep nuance in the paragraphs. Inherit the selected platform contract, link attribution, and Community Ending from the shared rules.
