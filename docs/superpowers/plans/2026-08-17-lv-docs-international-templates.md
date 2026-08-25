# LV Docs International Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add language-neutral international docs templates and a prompt-language-first localization workflow to `lv-docs`.

**Architecture:** Store the three reusable Markdown skeletons under `lv-docs/assets/templates/` and keep the main skill focused on selection, localization, SEO/GEO linking, and validation rules.
The current docs runtime remains unchanged: the skill creates English and Simplified Chinese source files, while `docs:sync` derives Traditional Chinese.

**Tech Stack:** Markdown Agent Skills, LightVela docs source layout, Fumadocs synchronization, OpenCC Traditional Chinese generation.

## Global Constraints

- Never use an em dash.
- Keep each complete sentence on its own physical Markdown line.
- Preserve user-owned changes in `frontend/src/content/docs/`.
- Do not commit or push without explicit user confirmation.
- Use the prompt-requested supported language as the canonical draft language.
- Generate and localize all international-site language sources in the same task.
- Require `lv-seo-geo` for international Use Cases, comparison, and deep-dive pages.

---

### Task 1: Add the three international template assets

**Files:**

- Create: `.agents/skills/product-skills/lv-docs/assets/templates/international-use-case.md`
- Create: `.agents/skills/product-skills/lv-docs/assets/templates/international-comparison.md`
- Create: `.agents/skills/product-skills/lv-docs/assets/templates/international-agent-deep-dive.md`

**Interfaces:**

- Consumes: The approved structure in `docs/superpowers/specs/2026-08-17-lv-docs-international-templates-design.md`.
- Produces: Three language-neutral Markdown skeletons referenced by `lv-docs/SKILL.md`.

- [ ] **Step 1: Record the current-skill baseline**

Run three outline scenarios against the unmodified `lv-docs` skill.

Expected: At least one scenario uses the old Chinese-first workflow, and the Use Cases scenario does not reliably place the required table after steps and before FAQ.

- [ ] **Step 2: Create the minimal template assets**

Create each skeleton with semantic placeholders such as `{{title}}`, `{{summary_heading}}`, and `{{lead_image}}`.

Use Cases must order the practical table after steps and before FAQ.

Comparison must place its lead image after Summary and its mandatory table immediately afterward.

Agent Deep Dive must place its lead image after Summary and include a mechanism or architecture table.

Agent Deep Dive must also provide modular examples for additional tables, Markdown records, JSON responses, YAML configuration, slash commands, Bash commands, and expected output or error blocks.

- [ ] **Step 3: Run structural checks**

Run:

```bash
rg -n "Summary|lead_image|table|FAQ|internal" .agents/skills/product-skills/lv-docs/assets/templates
```

Expected: All three files contain Summary, lead-image, table, and contextual-link guidance in the required order.

### Task 2: Amend the international `lv-docs` workflow

**Files:**

- Modify: `.agents/skills/product-skills/lv-docs/SKILL.md`
- Modify: `.agents/skills/product-skills/lv-docs/references/docs-rules.md`

**Interfaces:**

- Consumes: The three assets created in Task 1 and the existing international source directories.
- Produces: Template selection, prompt-language-first localization, SEO/GEO linking, and completion rules for future docs tasks.

- [ ] **Step 1: Replace the fixed Chinese-first international authoring order**

State that the explicitly requested supported language is canonical.

If no language is explicit, infer it from the requested output or dominant prompt language.

Require immediate localization into the other international source language and explain that `docs:sync` derives Traditional Chinese.

- [ ] **Step 2: Add template routing**

Map Use Cases, Compare & Choose, and Hermes Agent Deep Dive pages to their exact asset paths.

Require structural equivalence across localized files while allowing natural linguistic adaptation.

- [ ] **Step 3: Add the SEO/GEO link-graph contract**

Mark `lv-seo-geo` as a required sub-skill for these three international content types.

Require two to five distributed outgoing links and one to three useful inbound links from related international pages.

Retain the prohibition against standalone Related Reading sections.

- [ ] **Step 4: Update completion and final-report rules**

Treat missing `en/` or `global/` source, missing `zh-hant` synchronized output, or structural drift as incomplete work.

Require the final response to identify the canonical drafting language and generated localizations.

### Task 3: Validate the edited skill

**Files:**

- Test: `.agents/skills/product-skills/lv-docs/SKILL.md`
- Test: `.agents/skills/product-skills/lv-docs/assets/templates/*.md`

**Interfaces:**

- Consumes: The completed skill and templates.
- Produces: Validation evidence that the package is structurally valid and future agents apply the new workflow.

- [ ] **Step 1: Run the skill package validator**

Run:

```bash
python3 /Users/cassidyshi/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/product-skills/lv-docs
```

Expected: The validator reports a valid skill package.

- [ ] **Step 2: Run three post-change scenarios**

Test one English-first Use Cases prompt, one Chinese-first comparison prompt, and one English-first Agent Deep Dive prompt.

Expected: Every scenario names both source files, preserves the same template structure, places the lead image after Summary, includes the mandatory table, and plans contextual outbound and inbound links.

For the Agent Deep Dive scenario, also confirm that the template selects multiple focused tables and source-backed command, configuration, code, or output blocks when the topic supports them.

- [ ] **Step 3: Review the diff without touching docs content**

Run:

```bash
git diff --check
git diff -- .agents/skills/product-skills/lv-docs docs/superpowers/specs/2026-08-17-lv-docs-international-templates-design.md docs/superpowers/plans/2026-08-17-lv-docs-international-templates.md
```

Expected: No whitespace errors, no em dashes, and no changes to `frontend/src/content/docs/` from this task.
