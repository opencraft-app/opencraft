# Context Evaluation Case Studies

## Purpose

These three cases explain how to read the isolated pilot results without overstating causality. All cases use the same fixed model (`glm-5.3`, low reasoning effort), the same prompt, and fresh sessions for Control and Treatment.

## Cases

| Case | Query | Control Recall@5 | Treatment Recall@5 | Treatment consumed `docs/context` | Interpretation |
|---|---|---:|---:|---:|---|
| `mono2-mr-1065#run1` | Add automation effective window support | 0.143 | 0.714 | Yes, 7 references | Strong positive example |
| `mono2-mr-1457#run1` | Unify account and agents header navigation | 0.000 | 0.800 | No | Positive outcome, but not attributable to context consumption |
| `mono2-mr-1977#run1` | Change beta announcement to paid-version announcement | 0.625 | 0.000 | No | Negative outcome, but not attributable to context consumption |

### 1. Automation Effective Window: A Consumed Positive Case

The requirement was to add an automation effective window. Control mixed `ctl` backend automation files with the frontend Hermes Cron client and automations panel, yielding Recall@5 `0.143`.

Treatment loaded `docs/context` and stayed inside the frontend Hermes Cron and automations surface. It proposed:

- `frontend/src/lib/hermes-cron-client.ts`
- `frontend/src/pages/marketing/openclaw-automations-panel.tsx`
- corresponding tests
- generated i18n files

Recall@5 improved to `0.714`, full recall to `0.857`, and token usage decreased from 41,104 to 38,468. Tool calls increased from 5 to 7 and wall time from 116.2s to 135.5s.

This is the clearest positive case because the treatment log references `docs/context` seven times and the plan narrows to the right service boundary. It is still one sample, not statistical proof.

### 2. Unified Header Navigation: Positive But Not Context-Attributable

The requirement was to unify account and agents header navigation. Control returned no changed files in the structured field, so Recall@5 was `0`.

Treatment identified the shared site header, account pages, agents settings page, router constants, and focused tests. Recall@5 was `0.800`, with token usage reduced from 39,746 to 38,240 and wall time reduced from 160.2s to 75.0s.

However, the treatment log did not reference `docs/context`. The improved plan may reflect prompt, model, or session variance rather than the new context bundle. This case should be used as a quality example, not as evidence that `docs/context` caused the gain.

### 3. Paid-Version Announcement: Negative But Not Context-Attributable

The requirement was to change the beta announcement to a paid-version announcement. Control correctly found the banner component, announcement markdown, sidebar, docs sync script, SEO data, and generated i18n files, yielding Recall@5 `0.625`.

Treatment described a coherent approach but returned an empty changed-file list, producing Recall@5 `0`. Its log did not reference `docs/context`.

The useful lesson is not that context caused a regression. It is that the output contract failed: the model reasoned about the right implementation but did not populate the required structured file field. This motivates a stricter output-contract check in the runner.

## Findings

1. A positive aggregate number can hide an important split: context was consumed in only 23 of 50 treatment runs.
2. Cases with good outcomes but no context consumption must not be used as causal evidence.
3. Structured-output compliance is a separate failure mode from retrieval quality.
4. The best current improvement path is to make context consumption mandatory and validate that proposed files are nonempty before accepting a run.

## Promotion Talking Points

- We built a leakage-safe, paired, same-model evaluation rather than relying on qualitative impressions.
- The current interim result is directionally positive but not statistically significant.
- We discovered a more fundamental issue: context files exist, but agents often do not read them.
- The next iteration makes context load-bearing through mandatory routing, compact summaries, and a consumption preflight check.
