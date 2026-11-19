"""Read-only post-run diagnostics. No model calls and no overwrite of run results."""
import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path


async def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--upstream", type=Path, required=True)
    p.add_argument("--run", type=Path, required=True)
    args = p.parse_args()
    upstream, run = args.upstream.resolve(), args.run.resolve()
    plan = json.loads((run / "plan.json").read_text())
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=upstream, text=True).strip() != plan["upstreamRevision"]:
        raise RuntimeError("Diagnostic scorer revision differs from run")
    sys.path.insert(0, str(upstream))
    from src.evaluation.proactiveness_evaluator import ProactivenessEvaluator
    from src.evaluation.trace_history import (
        collect_model_task_turns, load_task_intent_judge_turns,
        load_task_followup_turn_styles,
    )
    model_id = "superapp-codex-pilot"
    traces = collect_model_task_turns(model_id=model_id, logs_dir=run / "traces", user_id="researcher")
    observed = [t for t in plan["tasks"] if ("researcher", t) in traces]
    score = await ProactivenessEvaluator(data_root=upstream / "data").evaluate_user(
        user_id="researcher", agent_id=model_id,
        turn_paths_by_task_id={t: traces[("researcher", t)] for t in observed}, task_ids=observed,
        followup_turn_styles_by_task_id={t: load_task_followup_turn_styles(output_dir=run, model_id=model_id, user_id="researcher", task_id=t) for t in observed},
        intent_judge_turns_by_task_id={t: load_task_intent_judge_turns(output_dir=run, model_id=model_id, user_id="researcher", task_id=t) for t in observed},
    )
    original = json.loads((run / "result.json").read_text())
    attempted = {t["task_id"] for t in original.get("completedTaskRuns", [])}
    result = {
        "kind": "post-run-observed-dialogues-diagnostic-no-new-model-calls",
        "planned": plan["tasks"], "observed": observed,
        "withoutDialogueTrace": [t for t in plan["tasks"] if t not in observed],
        "notRun": [t for t in plan["tasks"] if t not in attempted],
        "officialLeaderboardScore": None, "fullPlanScore": None,
        "observedProactiveness": score.to_dict(),
        "warning": "Observed-dialogue score cannot replace planned denominator or certify task completion. Original errors retained.",
    }
    with (run / "diagnostic-recovery.json").open("x") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
