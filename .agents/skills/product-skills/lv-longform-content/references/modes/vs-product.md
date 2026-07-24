# Vs Product / 竞品对比

Use for a practical comparison between LightVela and another product, or between LightVela and an alternative operating model such as self-hosting Hermes on a personal computer. The goal is to help a reader choose a fit—not to stage a corporate takedown.

## Research and fairness

- Research both sides before drafting. Use current first-party documentation, pricing, product pages, release notes, or hands-on evidence. Date time-sensitive facts and link the source. Do not turn assumptions, marketing copy, or old reviews into claims.
- Compare the actual job the reader wants done: setup effort, day-to-day ownership, availability, control, privacy/data boundary, integrations, maintenance, and cost only when the evidence supports it.
- Give the alternative a genuine “best for” case. Do not call LightVela the universal winner, hide meaningful tradeoffs, or use dismissive competitor language.

## Shape and voice

Keep this mode tighter than a broad enterprise comparison: usually 800–1,100 words unless the user sets a length.

Suggested arc:

```markdown
<LightVela vs. Alternative: Which Fits <specific job>?>
<One Codex-generated comparison hero image>

Answer-first: state who should choose each option in 1–3 plain sentences. Lead with the reader's real constraint, not a company claim.

## At a glance
<A compact Markdown table with 4–6 decision-useful rows.>

## What changes in everyday use
<Compare ownership and routine work with a concrete, ordinary scenario.>

## Where <alternative> is the better fit
<Give the strongest honest case for it.>

## Where LightVela is the better fit
<Explain the relevant product advantage in plain language, backed by verified facts.>

## Which should you choose?
<Use two short “Choose X if…” lists. Make the decision conditional, not absolute.>
```

Write like a thoughtful builder talking to another builder: direct, specific, and human. Use a small, relatable tension in the opening, then move quickly to the decision. Prefer “if this is your setup…” over “best-in-class,” “enterprise-ready,” “revolutionary,” or similar corporate language.

## Hero image

Generate the first image with Codex `imagegen` for every `vs-product` article. It must be one clean 16:9 editorial comparison hero—never a `[RECOMMEND ADD IMAGE: ...]` placeholder. Always include `assets/vs-product-hero-reference.png` as the composition reference: preserve its soft lavender/pale-violet background, LightVela left half, exact straight center divider, sparse scale, and calm premium editorial composition. Change only the right half to fit the alternative. Text is optional; if used, keep it short, readable, and secondary rather than enforcing the industry template's headline placement.

For a side-by-side comparison, place LightVela on the **left** and the alternative on the **right**. When an official alternative icon/logo is available from that company's official site or a user-supplied asset, use it as a faithful reference on the right; otherwise use one obvious, unbranded physical metaphor for that alternative. For “host on your own computer,” replace the right-side icon with one clean personal laptop, showing only subtle abstract terminal marks. Make the comparison legible without turning it into a hostile logo battle. Recommend any later in-body images only when they make a specific decision easier.

Keep the composition deliberately sparse: one principal icon/object per side and, at most, one small supporting context object per side. Use a straight split divider or exactly one fixed-size circular marker at the visual center—never multiple floating circles or inconsistent circle sizes/shapes. Avoid decorative connection nodes, repeated badges, dense UI panels, extra server stacks, or visual elements that do not clarify the comparison.

When the visual includes LightVela, use `assets/lightvela-brand-icon.png` as the approved brand-icon reference. Preserve the recognizable mark and keep it modest on the LightVela side; do not alter it into a new mascot or use it as a competitor logo. See `references/brand-assets.md`.

Use a table only for concise comparisons; keep nuance in the paragraphs. Inherit the selected platform contract, link attribution, and Community Ending from the shared rules.
