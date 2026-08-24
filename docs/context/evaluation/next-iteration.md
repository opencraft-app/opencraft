# Next Context Iteration

## Goal

Make repository context load-bearing for AI coding, not merely available on disk.

## Trigger

The current frozen 50-sample experiment is complete. Start this iteration after archiving the branch and obtaining review confirmation.

## Problems To Solve

1. Only 23 of 50 treatment runs referenced `docs/context`.
2. Root `AGENTS.md` links are advisory and can be skipped.
3. The treatment effect is diluted because many runs are effectively control runs with unused files.
4. The current dataset is frontend-heavy and does not fully test external cloud, billing, or cross-service knowledge.

## Changes

### 1. Make Context Consumption Mandatory

Update the root `AGENTS.md` so that, before code planning, the agent must:

1. read `docs/context/README.md`;
2. read `context-routing.yaml`;
3. select only the routed domain or project documents;
4. record which context files were consumed.

Do not turn this into a full repository audit. The instruction should be short and imperative.

### 2. Add A Compact Context Summary

Add a short, high-signal summary directly to the root `AGENTS.md` or to the task prompt:

- repository map;
- task-type routing table;
- external-knowledge domains;
- current task context path;
- verification requirements.

This gives the model a usable map even when it does not follow links.

### 3. Add A Preflight Consumption Check

Extend the evaluation runner:

1. after each treatment run, inspect the log for `docs/context`;
2. if absent, mark the sample `context_not_consumed`;
3. either rerun with explicit context injection or exclude it from the treatment-effect claim.

This prevents “we added context” from being confused with “the model used context”.

### 4. Expand External Knowledge

Add or refine context for knowledge that cannot be recovered from source code alone:

- Tencent Cloud API contracts;
- billing and Pass entitlement rules;
- Cloud API error codes and limits;
- CAM and security boundaries;
- region-specific behavior;
- external service SLAs and quotas.

Prefer concise, source-linked documents over long narrative guides.

### 5. Improve Skill Governance

After the current experiment:

1. add `context-audit` to `docs/context/skills/inventory.md`;
2. assign owners to every Skill;
3. split Skills over 500 lines;
4. remove or archive duplicate capabilities;
5. keep trigger descriptions specific enough to avoid accidental activation.

### 6. Re-Freeze And Re-Evaluate

1. Freeze the new context bundle.
2. Run a held-out subset before scaling.
3. Compare:
   - context consumption rate;
   - Recall@5;
   - MRR;
   - token usage;
   - wall time;
   - tool calls;
   - context-not-consumed rate.
4. Only claim improvement if consumption increases and quality does not regress.

## Success Criteria

- Context consumption rate rises from 23/50 to at least 70%.
- Treatment Recall@5 improves without increasing token usage.
- Context-not-consumed rate is reported explicitly.
- External cloud and billing queries have dedicated routing.
- Skill inventory remains complete and owner-assigned.
