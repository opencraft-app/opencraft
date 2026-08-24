# Context Evaluation Runbook

## Preconditions

1. Use the same fixed model for both arms: `glm-5.3` with low reasoning effort. Do not introduce another model or model tier.
2. Freeze the dataset commit and record it in the result.
3. Keep query, gold, patch, and evaluation fixtures outside indexed corpus.
4. Do not grant the treatment arm extra tools or permissions.

## Control Arm

1. Start from the dataset `base_commit`.
2. Load only the original root `AGENTS.md`, service `AGENTS.md`, OpenSpec, and Skills available at that commit.
3. Provide the `requirement_query`.
4. Ask the agent to produce:
   - changed-file plan;
   - required tests;
   - implementation approach;
   - risks and rollout checks.
5. Record token usage, wall time, tool calls, and output.

## Treatment Arm

1. Start from the same `base_commit`.
2. Load the new context stack:
   - slim root `AGENTS.md`;
   - service `AGENTS.md`;
   - `docs/context/context-routing.yaml`;
   - routed domain file;
   - task template;
   - Skill inventory.
3. Provide the same `requirement_query`.
4. Ask for the same four outputs.
5. Record the same metrics.

## Scoring

| Metric | Definition |
|---|---|
| Hit@5 | At least one gold changed file appears in the agent's first five proposed files |
| Recall@5 | Intersection of proposed first five files and gold files divided by gold file count |
| MRR | Reciprocal rank of the first gold file in the proposed file list |
| Test selection | Whether proposed tests overlap gold verification commands or test files |
| Semantic correctness | Whether the plan satisfies the requirement without scope drift |
| Scope drift | Whether the agent proposes unrelated services or files |
| Token cost | Input, output, cache hit, and total tokens |
| Speed | Wall time and tool-call count |

## Output Template

```json
{
  "run_id": "",
  "arm": "control|treatment",
  "model": "",
  "dataset_commit": "",
  "context_commit": "",
  "sample_id": "",
  "proposed_files": [],
  "proposed_tests": [],
  "semantic_correctness": "pass|partial|fail",
  "scope_drift": false,
  "metrics": {
    "hit_at_5": 0,
    "recall_at_5": 0.0,
    "mrr": 0.0,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_hit_rate": 0.0,
    "wall_time_ms": 0,
    "tool_calls": 0
  },
  "evidence": ""
}
```

Use [prompt-template.md](prompt-template.md) for both arms.

## Resume State

Current valid paired samples: 50. The fixed-model evaluation is complete.

Documented invalid samples:

- `mono2-mr-293`
- `mono2-mr-900`
- `mono2-mr-2360`
- `mono2-mr-2359`
- `mono2-mr-2554`
- `mono2-mr-3144`

There is no next sample in the current fixed-model run. The next execution should follow [next-iteration.md](next-iteration.md), re-freeze the context bundle, and use a held-out subset.

Continue by sample ID rather than default order so known timeout cases are not retried accidentally. A sample is valid only when both Control and Treatment complete and the result is appended to `pilot-isolated-results.jsonl`.

## Reporting

Report paired differences, not only aggregate means. Include:

- overall mean and median;
- worst 10%;
- frontend, backend, and cross-service slices;
- small, medium, and large tasks;
- zero-result and scope-drift cases;
- fixed-model stability and confidence interval.
