# Pilot Contamination Audit

## Verdict

The 16-record isolated pilot is invalidated as effectiveness evidence.

The treatment worktree copied the entire `docs/context/` directory, including `docs/context/evaluation/candidates.jsonl`. That file contains each sample's gold changed files, raw MR description, merge commit, and verification evidence. The prompt told the agent not to use these fields, but it did not remove the file from the worktree.

Log inspection confirmed that treatment runs read `candidates.jsonl` for at least these samples:

- `mono2-mr-210`
- `mono2-mr-900`
- `mono2-mr-904`
- `mono2-mr-1253`
- `mono2-mr-1305`
- `mono2-mr-1312`
- `mono2-mr-1503`
- `mono2-mr-1598`

Because the gold-side file was physically available in the treatment environment, all 16 records are treated as contaminated even where logs did not show an explicit read.

## Preserved Data

The contaminated records are retained in [contaminated-pilot-results.jsonl](contaminated-pilot-results.jsonl) for diagnosis only. They must not be used in aggregate effectiveness claims.

## Root Cause

The runner used:

```text
cp -R docs/context <treatment-worktree>/docs/context
```

This copied the evaluation corpus and gold data into the treatment arm.

## Corrective Requirements

1. Build a sanitized treatment context bundle.
2. Exclude `docs/context/evaluation/` and task-specific audit records.
3. Copy only the frozen context contracts and domain/project facts.
4. Verify the treatment worktree contains no `candidates.jsonl`, raw descriptions, merge commits, changed-file lists, or verification evidence.
5. Keep the scorer and dataset outside both arms.
6. Add a preflight check that fails the run if gold-side paths exist in either worktree.
7. Record a context manifest hash.

## Remaining Value

The invalidated pilot still proved that:

- fresh Codex CLI sessions can execute both arms;
- output can be normalized and scored;
- logs can be audited for leakage;
- contamination can be detected post-run.

It did not prove that the new context improves recall.
