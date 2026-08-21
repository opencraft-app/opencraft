# International Docs Template Design

## Goal

Add three reusable international documentation templates to `lv-docs` for Use Cases, Compare & Choose, and Hermes Agent Deep Dive pages.

The templates must work from either English or Chinese input and produce every supported international-site language version in one task.

## Authoring and localization model

The language explicitly requested by the user is the canonical drafting language.

If the user does not name a language, use the language requested for the output or the dominant language of the prompt.

After the canonical draft is complete, localize it into the other international source language while preserving the information architecture, claims, tables, image positions, links, examples, warnings, and limitations.

International English is stored in `frontend/src/content/docs/en/<file>.md`.

International Simplified Chinese is stored in `frontend/src/content/docs/global/<file>.md`.

Traditional Chinese remains generated from the Simplified Chinese source by `pnpm docs:sync`.

A new or substantially rewritten international page is incomplete until both English and Simplified Chinese source files exist and the generated Traditional Chinese output has been synchronized.

## Shared template contract

All three template families use one language-neutral structure with localized headings and prose.

Each page begins with a unique `Summary` or `摘要` that directly answers the page title.

The recommended lead image appears immediately after the complete Summary prose and before the next section.

Each page includes a concise evidence or boundary section appropriate to its content type.

Each page uses factual, descriptive image alt text.

Each page uses contextual internal links instead of a standalone Related Reading section.

For SEO and GEO work, `lv-docs` requires `lv-seo-geo` and performs a small link-graph pass.

The page must include two to five relevant outgoing internal links distributed through the body.

One to three closely related existing international pages should receive a contextual link back to the new page when the relationship genuinely helps readers.

Every linked route must be verified against the international docs route and registration sources.

## Use Cases template

The Use Cases template follows the personal AI assistant reference page while making the workflow easier to reuse.

Its section order is Summary, lead image, audience and outcome, prerequisites, steps, practical decision or verification table, validation and boundaries, FAQ, and concise conclusion.

The required table appears after the complete steps section and before FAQ.

The table summarizes a useful operating choice such as stage, action, component, expected result, or failure signal.

## Compare & Choose template

The comparison template follows the LightVela versus local agent reference page.

Its section order is Summary, lead image, at-a-glance comparison table, core distinction, dimension-by-dimension analysis, conditional fit guidance, evidence and limitations, FAQ when useful, and conclusion.

The comparison table is mandatory and uses neutral dimensions supported by current official sources.

It states conditional fit instead of declaring a universal winner.

## Hermes Agent Deep Dive template

The deep-dive template follows the Hermes Agent versus OpenClaw reference page while tightening source discipline.

Its section order is Summary, lead image, why the question matters, definitions or architecture table, mechanism breakdown, concrete example or sequence, boundaries and failure modes, clearly labeled LightVela interpretation, FAQ when useful, and key takeaways.

At least one table is required when the topic contains multiple mechanisms, layers, states, or entities.

Use multiple focused tables when the topic has distinct dimensions such as write criteria, state transitions, configuration modes, or user-visible results.

Add source-backed technical evidence blocks when relevant, including Markdown records, JSON responses, YAML configuration, slash commands, CLI commands, and expected output or error examples.

Every fenced block must use the correct language identifier and have nearby prose explaining what the reader should notice.

Do not force every block type into every article; select only blocks supported by the topic and primary sources.

Third-party and upstream mechanism claims must use primary official sources.

## Scope

This change updates the `lv-docs` skill and adds template assets only.

It does not add machine translation infrastructure or change the docs runtime.

The skill itself performs the translation and localization step during document generation.

## Verification

Validate the skill package structure with the skill validator.

Run baseline and post-change outline scenarios for all three content types.

Confirm the post-change outputs preserve prompt-language-first authoring, paired international source generation, Summary-image placement, required tables, and bidirectional contextual linking.
