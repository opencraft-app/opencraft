# Context Consumption Audit

## Question

Did the treatment arm actually consume the repository context bundle, or did it only receive the files without reading them?

## Method

For each valid tool-assisted paired sample, decompress the treatment log and count whether `docs/context` appears in any command or output. This is a consumption signal, not a quality judgment.

## Result

- Valid paired samples: 50
- Treatment logs referencing `docs/context`: 23
- Treatment logs with no `docs/context` reference: 27

Samples that referenced `docs/context`:

- `mono2-mr-210#run1`
- `mono2-mr-1065#run1`
- `mono2-mr-1253#run1`
- `mono2-mr-1675#run1`
- `mono2-mr-2265#run1`
- `mono2-mr-2547#run1`
- `mono2-mr-2586#run1`
- `mono2-mr-2649#run1`
- `mono2-mr-2498#run1`
- `mono2-mr-2216#run1`
- `mono2-mr-2516#run1`
- `mono2-mr-2093#run1`
- `mono2-mr-2094#run1`
- `mono2-mr-2814#run1`
- `mono2-mr-643#run1`
- `mono2-mr-1923#run1`
- `mono2-mr-2620#run1`
- `mono2-mr-2470#run1`
- `mono2-mr-2090#run1`
- `mono2-mr-2132#run1`
- `mono2-mr-2092#run1`
- `mono2-mr-3036#run1`
- `mono2-mr-3028#run1`

Among those 23, the paired Top-5 Recall outcome was 11 wins, 5 ties, and 7 losses. The mean paired difference was `+0.052`. Among the 27 non-consuming runs, the outcome was 10 wins, 10 ties, and 7 losses, with a mean paired difference of `+0.038`. Consumption did not dramatically improve outcomes in this iteration, but the low overall consumption rate remains a fundamental implementation problem.

## Interpretation

The current treatment bundle is present in the repository, but the agent often follows the service-level `AGENTS.md` and the task query without opening `docs/context/README.md` or `context-routing.yaml`. Root `AGENTS.md` links to the context entry point, but those links are advisory; they do not force the agent to consume the context before planning.

This explains part of the unstable evaluation result: many treatment runs are effectively control runs with extra unused files.

## Next Iteration

1. Make the root entry point more imperative: before code planning, read `docs/context/README.md` and `context-routing.yaml`.
2. Consider injecting a compact context summary directly into the task prompt or `AGENTS.md`, rather than relying on the agent to follow links.
3. Add a preflight consumption check to the evaluation runner: if the treatment log does not reference `docs/context`, mark the sample as `context_not_consumed` or rerun it with explicit context injection.
4. Keep the frozen context hash unchanged for the current experiment; apply these changes only in the next context iteration.
