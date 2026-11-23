"""Pinned official simulator; capability-limited product dialogue, not leaderboard."""
import argparse
import asyncio
import dataclasses
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

REVISION = "4f545be5d289b28ff022d2904d455007358ed3b7"
TASKS = [f"researcher_task_{n:03d}" for n in range(1, 4)]


def write(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str) + "\n")
    path.chmod(0o600)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--model-profile", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dialogue-probe", action="store_true",
                        help="Explicitly run the incomplete dialogue adapter; default is no-call readiness check")
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=upstream, text=True).strip()
    if head != REVISION or subprocess.check_output(["git", "diff", "HEAD", "--"], cwd=upstream):
        raise RuntimeError("Upstream revision or tracked source differs")
    output.mkdir(mode=0o700)  # Never overwrite a known run.
    os.chdir(upstream)
    sys.path.insert(0, str(upstream))
    from src.channels.base import BaseChannel
    from src.channels.reset_policy import ExactMatchResetPolicy
    from src.runner.runner import BenchmarkRunner
    from src.user_agent.user_agent import UserAgent
    from src.llm import LLMClient
    from src.evaluation.runner import TraceEvaluationRunner
    from src.utils import configure_logging

    if not args.dialogue_probe:
        readiness = {"upstreamRevision": head, "modelCalls": 0, "officialBenchmarkReady": False,
                     "blockers": ["No AppWorld/search/workspace-write tools",
                                  "No native tool/attachment trace conversion"],
                     "diagnosticProbeAvailable": True,
                     "probeWarning": "Conversation switching is supported; tool and trace adapters remain incomplete. No full score."}
        write(output / "readiness.json", readiness)
        print(json.dumps(readiness))
        return

    config = json.loads((args.model_profile / "profile.json").read_text())
    model = config["harnesses"]["codex"]
    key_path = Path(model["credentialFile"])
    if key_path.is_symlink() or key_path.stat().st_mode & 0o077:
        raise RuntimeError("Credential must be an owner-only regular file")
    key = key_path.read_text().strip()
    source_files = sorted(set(subprocess.check_output(
        ["git", "ls-files", "-co", "--exclude-standard", "src", "bin", "evaluation/pibench", "package-lock.json"],
        cwd=root, text=True).splitlines()))
    plan = {
        "track": "pibench-capability-limited-dialogue-pilot-v1",
        "upstreamRevision": head, "tasks": TASKS, "selection": "researcher episode first three, unchanged order",
        "sourceRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "sourceStatus": subprocess.check_output(["git", "status", "--short"], cwd=root, text=True),
        "sourceFiles": {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in source_files},
        "datasetFiles": {p.relative_to(upstream).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in (upstream / "data/researcher").rglob("*.yaml")},
        "assistant": {"model": model["modelId"], "harness": "codex", "baseUrl": model["baseUrl"]},
        "simulatorAndJudge": {"model": model["modelId"], "protocol": "chat-completions", "maxRetries": 2, "intentParseRetries": 2},
        "memoryPolicy": config["memoryPolicy"], "maxTurnsPerTask": 6, "episodeDeadlineSeconds": 900,
        "productTurnDeadlineSeconds": 180, "startedAt": datetime.now(timezone.utc).isoformat(),
        "limitations": ["No AppWorld, Brave search or general file writes", "One persistent profile; each official /new creates a distinct product conversation retaining memory",
                        "User/judge model differs from upstream gpt-5.4 default; same-model judgment bias",
                        "Visible dialogue traces only; no native tool trace conversion or attachment expansion",
                        "No dependency-chain or full 100-task score; simulator termination is not task success"],
        "officialLeaderboardScore": None,
    }
    write(output / "plan.json", plan)
    configure_logging(level="WARNING")
    model_id = "opencraft-codex-pilot"
    logs = output / "traces"
    workspace = output / "simulator-workspace"
    workspace.mkdir()

    class ProductChannel(BaseChannel):
        def __init__(self):
            super().__init__({})
            self.task = None
            self.histories = {}
        def set_runtime_identity(self, *, sender_id, chat_id):
            self.task = chat_id
            if chat_id not in self.histories:
                self.histories[chat_id] = {"messages": [], "turn": 0,
                                          "timestamp": datetime.now().strftime("%Y%m%d_%H%M%S")}
        def build_reset_response_policies(self):
            return [ExactMatchResetPolicy("New session started")]
        async def connect(self):
            self.stderr = (output / "product-stderr.log").open("wb")
            self.process = await asyncio.create_subprocess_exec(
                str(args.node), str(root / "evaluation/pibench/channel.mjs"), str(args.model_profile), str(output),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=self.stderr,
                env={"PATH": str(args.node.parent) + ":/usr/bin:/bin", "LANG": "C.UTF-8"},
                cwd=root, start_new_session=True)
        async def disconnect(self):
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 20)
            except asyncio.TimeoutError:
                import signal
                os.killpg(self.process.pid, signal.SIGKILL)
                await self.process.wait()
            finally:
                self.stderr.close()
        async def send(self, message):
            payload = {"op": "reset"} if message == "/new" else {"op": "say", "content": message}
            self.process.stdin.write((json.dumps(payload) + "\n").encode())
            await self.process.stdin.drain()
            raw = await asyncio.wait_for(self.process.stdout.readline(), 195)
            if not raw:
                raise RuntimeError("Product channel exited before reply")
            reply = json.loads(raw)
            if "error" in reply:
                raise RuntimeError(reply["error"])
            if payload["op"] != "reset":
                state = self.histories[self.task]
                state["turn"] += 1
                state["messages"].extend([{"role": "user", "content": message}, {"role": "assistant", "content": reply["content"]}])
                dest = logs / model_id / "researcher" / self.task / state["timestamp"]
                dest.mkdir(parents=True, exist_ok=True)
                write(dest / f"turn_{state['turn']}.json", {"messages": state["messages"], "tool_steps": []})
            await self._recv(reply["content"])

    llm = LLMClient(model=model["modelId"], base_url=model["baseUrl"], api_key=key,
                    temperature=0, max_retries=2, request_timeout=60)
    user = UserAgent(user_root="data/researcher", llm_client=llm, task_ids=TASKS,
                     output_root=str(output), model_id=model_id, workspace_dir=workspace,
                     intent_parse_retries=2)
    result = {"officialLeaderboardScore": None, "completedTaskRuns": []}

    class ObservedRunner(BenchmarkRunner):
        async def _run_one_task(self, task):
            # Persist the official outcome before its post-task reset can fail.
            outcome = await super()._run_one_task(task)
            result["completedTaskRuns"].append(dataclasses.asdict(outcome))
            write(output / "result.json", result)
            return outcome
    try:
        async with ProductChannel() as channel:
            runner = ObservedRunner(channel, user, max_turns=6, turn_timeout=195)
            run = await asyncio.wait_for(runner.run(), 900)
            result["run"] = dataclasses.asdict(run)
    except Exception as error:
        result["runError"] = {"type": type(error).__name__, "message": str(error)}
    observed = [t["task_id"] for t in result["completedTaskRuns"]]
    result["notRun"] = [t for t in TASKS if t not in observed]
    write(output / "result.json", result)
    try:
        evaluator = TraceEvaluationRunner(model_id=model_id, user_id="researcher", logs_dir=logs,
            workspace_dir=workspace, config_path=upstream / "config/bench/evaluation/trace_history.yaml",
            output_dir=output, scoring="both", llm_client=llm, task_ids=observed or TASKS)
        scored = await asyncio.wait_for(evaluator.run(), 300)
        result["diagnosticUpstreamScoring"] = dataclasses.asdict(scored)
    except Exception as error:
        result["scoringError"] = {"type": type(error).__name__, "message": str(error)}
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    write(output / "result.json", result)
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    asyncio.run(main())
