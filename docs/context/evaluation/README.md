# Repository Context Evaluation

## Goal

Measure whether repository-level Context Engineering improves real AI coding outcomes, not whether a retrieval system scores well in isolation.

## Dataset

- Source: real merged MRs in `wisp/mono2` from 2026.
- Query: sanitized requirement intent from the MR title or the `需求描述` / `背景` section.
- Raw MR description: retained as `raw_description` for provenance only, never used as the agent query.
- Gold: merge commit changed files and verification evidence.
- Minimum size: 50 samples.
- Candidate pool: 96 MRs satisfy the basic query and merge SHA requirements.
- Eligible pool after excluding release-only, generated subtree, and oversized changes: 69 MRs.
- Current dataset: [candidates.jsonl](candidates.jsonl) contains 56 selected records — the initial 50 plus 6 replacements for invalid attempts.
- Pilot queries: [pilot-queries.jsonl](pilot-queries.jsonl) contains the first 10 records without gold answers.
- Final fixed-model report: [final-report.md](final-report.md).
- Historical 22-sample interim report: [pilot-report.md](pilot-report.md).
- Three representative case studies: [case-studies.md](case-studies.md).
- Promotion narrative and rollout plan: [../promotion-plan.md](../promotion-plan.md).
- Context consumption audit: [context-consumption-audit.md](context-consumption-audit.md).
- Next iteration plan: [next-iteration.md](next-iteration.md).
- Repository context audit: [../audits/2026-08-20-context-audit.md](../audits/2026-08-20-context-audit.md).
- Context audit Skill: [context-audit](../../../.agents/skills/context-audit/SKILL.md).
- Context-only diagnostic results: [context-only-results.jsonl](context-only-results.jsonl).

Each sample must contain:

```text
id
mr_iid
requirement_query
base_commit
merge_commit
changed_files
required_tests
verification_evidence
source_branch
target_branch
service_labels
risk_labels
size_label
created_at
```

## Sampling Quota

| Dimension | Target |
|---|---|
| Primary service | frontend 30, ctl 7, trade 2, cloudladdergateway 2, gateway-dashboard 2, other 7 |
| Size | small 20, medium 21, large 9 |
| Time | spread across April to August 2026 |

## Experiment Arms

| Arm | Context |
|---|---|
| Control | Existing root `AGENTS.md`, service `AGENTS.md`, OpenSpec, and Skills |
| Treatment | Slim root entry, `docs/context/` routing, domain facts, task template, and Skill inventory |

Both arms must use the same model, tools, prompt, timeout, base commit, gold, and budget. The treatment may load different context content, but must not receive more tool permissions.

## Metrics

| Layer | Metric |
|---|---|
| Retrieval | Hit@5, Recall@5, MRR, zero-result rate |
| Delivery | changed-file overlap, required-test selection, semantic correctness, scope drift |
| Efficiency | input tokens, output tokens, cache hit rate, wall time, tool calls |
| Safety | secret exposure, unauthorized external action, stale fact use, scope expansion |

## Model Comparison

Run the full dataset with the current fixed model only: `glm-5.3` with low reasoning effort. Do not introduce another model or model tier in this evaluation. Success requires the treatment arm to improve or preserve quality and efficiency under the fixed model, and every reported sample must be a valid paired Control/Treatment run.

## Hard Gates

- Query, gold, patch, and evaluation fixtures stay outside indexed corpus.
- `raw_description`, changed files, tests, and verification evidence are gold-side data and must not be shown to the agent before it produces its plan.
- Do not use future MR content in control context.
- Do not claim causal improvement without paired runs.
- Report worst cases and service slices, not only averages.
- Never store credentials or raw sensitive logs in evaluation artifacts.

## Execution Files

- [dataset.schema.json](dataset.schema.json): sample contract.
- [prompt-template.md](prompt-template.md): common control and treatment instructions.
- [runbook.md](runbook.md): execution and scoring procedure.
