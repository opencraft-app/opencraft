#!/usr/bin/env python3
"""Check the finite recovery model and require exact negative-control failures."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

TLC_SHA256 = "d15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f"
CASES = [
    ("NativeMessagePublication-Observed", "CurrentFrameOwner"),
    ('NativeMessagePublication', None),
    ('NativeMessagePublication-Publication', 'AdmissionOwned'),
    ('NativeMessagePublication-Callback', 'CurrentFrameOwner'),
    ('NativeMessagePublication-Live', 'AdmittedOnly'),
    ('NativeMessagePublication-Exception', 'ObserverNotNativeFailure'),
    ('NativeMessagePublication-Decode', 'DecodeFailureOwned'),
    ('NativeMessagePublication-NoFairness', 'temporal:DecodedProgress'),
    ('HostTerminalPublication', None),
    ('HostTerminalPublication-Exception', 'ExceptionIsolated'),
    ('HostTerminalPublication-Live', 'AdmittedOnly'),
    ('HostTerminalPublication-Closed', 'TerminalConserved'),
    ('HostTerminalPublication-NoFairness', 'temporal:TerminalProgress'),

    ('ReplayDrainAdmission', None),
    ('ReplayDrainAdmission-LateJoin', 'AdmissionHasWorker'),
    ('ReplayDrainAdmission-Cleanup', 'CompletionOwned'),
    ('ReplayDrainAdmission-NoFairness', 'temporal:FrameProgress'),
    ("ReplayLifetime-CloseOwner", "SuccessorNativeState"),
    ('ReplayLifetime', None),
    ('ReplayLifetime-Epoch', 'CurrentFrameOwner'),
    ('ReplayLifetime-Cursor', 'CursorBounds'),
    ('ReplayLifetime-Reservation', 'ClaimConsumed'),
    ('ReplayLifetime-Double', 'AtMostOnce'),
    ('ReplayLifetime-Early', 'NoEarlyAdmission'),
    ('ReplayLifetime-Resurrect', 'NoResurrection'),
    ('ReplayLifetime-Caller', 'CallerNotNative'),
    ('ReplayLifetime-WaitClock', 'temporal:LocalCompletion'),
    ('ReplayLifetime-NoLocalFairness', 'temporal:SuccessorCompletion'),
    ('ReplayLifetime-NoClockFairness', 'temporal:SuccessorCompletion'),
    ('RecordingLifetime', None),
    ('RecordingLifetime-Cleanup', 'SuccessorTap'),
    ('RecordingLifetime-Terminal', 'TerminalConserved'),
    ('RecordingLifetime-Sample', 'NoFakePublication'),
    ('RecordingLifetime-Sink', 'temporal:FrameProgress'),
    ('RecordingLifetime-Observer', 'temporal:FrameProgress'),
    ('RecordingLifetime-Frame', 'NoStaleFrame'),
    ('RecordingLifetime-FailedClose', 'CleanupOwned'),
    ('RecordingLifetime-NoFairness', 'temporal:SuccessorProgress'),
    ('ClientRetirement', None),
    ('ClientRetirement-Repeat', 'temporal:FutureOutcome'),
    ('ClientRetirement-FirstCleanup', 'OldRequestsRetired'),
    ('ClientRetirement-Rearm', 'NewActivityRetired'),
    ('ClientRetirement-Constructor', 'InitialActivityRetired'),
    ('ClientRetirement-Join', 'temporal:FutureOutcome'),
    ('ClientRetirement-StaleCatch', 'temporal:FutureOutcome'),
    ('ClientRetirement-Eager', 'temporal:FutureOutcome'),
    ('ClientRetirement-NoLocalFairness', 'temporal:FutureOutcome'),
    ('ClientRetirement-NoNativeFairness', 'temporal:FutureOutcome'),
    ('MemoryGenerations', None),
    ('MemoryGenerations-LateAdmission', 'CurrentStatus'),
    ('MemoryGenerations-OldPeerClose', 'CurrentStatus'),
    ('MemoryGenerations-OldPeerSend', 'FrameOwner'),
    ('MemoryGenerations-QueuedFrame', 'FrameOwner'),
    ('MemoryGenerations-OldAck', 'CurrentStatus'),
    ('MemoryGenerations-WaitCancel', 'temporal:LocalCompletion'),
    ('MemoryGenerations-EarlyCleanup', 'CleanupAfterAdmission'),
    ('MemoryGenerations-RepeatCleanup', 'CleanupAtMostOnce'),
    ('MemoryGenerations-NoCleanupFairness', 'temporal:CleanupProgress'),
    ('MemoryGenerations-NoLiveFairness', 'temporal:CurrentCompletion'),
    ('TransportObservers', None),
    ('TransportObservers-Exception', 'ObserverIsolation'),
    ('TransportObservers-Token', 'TokenOwnership'),
    ('TransportObservers-Live', 'AdmittedOnly'),
    ('TransportObservers-Stale', 'CurrentPublication'),
    ('TransportObservers-Repeat', 'AtMostOnce'),
    ('TransportObservers-Orphan', 'temporal:ConnectCompletion'),
    ('TransportObservers-Loss', 'temporal:FailureDelivery'),
    ('TransportObservers-Terminal', 'temporal:FailureDelivery'),
    ('TransportObservers-Clear', 'temporal:FailureDelivery'),
    ('TransportObservers-EagerInit', 'temporal:SuccessorReady'),
    ('TransportObservers-NoFairness', 'temporal:ConnectCompletion'),
    ('TransportObservers-NoInitFairness', 'temporal:SuccessorReady'),
    ("HandlerRegistration", None),
    ("HandlerRegistration-Token", "TokenOwnership"),
    ("HandlerRegistration-Cancel", "RegistrationDoesNotRevoke"),
    ("HandlerRegistration-Retarget", "ReplyOwner"),
    ("HandlerRegistration-NoFairness", "temporal:RequestCompletion"),
    ("Recovery", None),
    ("Recovery-Safety", None),
    ("Recovery-DropHint", "WakeConserved"),
    ("Recovery-HoldGate", "temporal:ThreadRecovery"),
    ("Recovery-Stale", "SingleWriter"),
    ("Recovery-CrossHost", "HostIsolation"),
    ("Recovery-Replay", "NoDuplicateCommand"),
    ("Recovery-Barrier", "PhysicalBarrier"),
    ("Recovery-Witness", "NoHealthyRecoveryWitness"),
    ("Recovery-NoFairness", "temporal:ThreadRecovery"),
    ("Recovery-RetiredAttempt", "temporal:ThreadRecovery"),
    ("Recovery-Revive", "DisposedTerminal"),
    ("Recovery-WakeOnly", None),
    ("Recovery-WakeLiveness", "temporal:ThreadRecovery"),
    ("RequestTimers", None),
    ("RequestTimers-StaleTimer", "NoEarlyTimeout"),
    ("RequestTimers-StaleRequest", "TimeoutOwnership"),
    ("RequestTimers-NoFairness", "temporal:RequestTermination"),
    ("HistoryReentry", None),
    ("HistoryReentry-Admission", "DisposalSettles"),
    ("HistoryReentry-Progress", "SafeProgressRead"),
    ("HistoryReentry-Commit", "SuccessorWorkOwner"),
    ("HistoryReentry-Slot", "SuccessorSlotOwner"),
    ("HistoryReentry-Backoff", "ImmediateRetry"),
    ("HistoryReentry-Cleanup", "SuccessorSlotOwner"),
    ("HistoryReentry-NoFairness", "temporal:HistoryTermination"),
    ('HydrationHandoff', None),
    ('HydrationHandoff-Binding', 'temporal:HydrationRecovery'),
    ('HydrationHandoff-Session', 'temporal:HydrationRecovery'),
    ('HydrationHandoff-Commit', 'CurrentAuthority'),
    ('HydrationHandoff-Cleanup', 'SuccessorSlots'),
    ('HydrationHandoff-Settlement', 'CancelledWaiterSettles'),
    ('HydrationHandoff-NoFairness', 'temporal:HydrationRecovery'),
    ('DerivedHistory', None),
    ('DerivedHistory-Dependency', 'NoFutureDependency'),
    ('DerivedHistory-Settlement', 'RetiredSettles'),
    ('DerivedHistory-Cleanup', 'CurrentSlots'),
    ('DerivedHistory-Intent', 'IndependentIntent'),
    ('DerivedHistory-NoFairness', 'temporal:DerivedTermination'),
    ('ClockDomains', None),
    ('ClockDomains-Backward', 'NoExtension'),
    ('ClockDomains-Forward', 'NoEarly'),
    ('ClockDomains-NoFairness', 'temporal:BudgetTermination'),
    ('ViewReadLease', None),
    ('ViewReadLease-Acquire', 'AcquireProtected'),
    ('ViewReadLease-SelfPin', 'ReadHasDemand'),
    ('ViewReadLease-Peer', 'PeerReadPreserved'),
    ('ViewReadLease-Baseline', 'CachedBaseline'),
    ('ViewReadLease-NoFairness', 'temporal:AcquireProgress'),
    ('ActivationHistory', None),
    ('ActivationHistory-ExecutionFair', None),
    ('ActivationHistory-StrategyGate', 'temporal:CommandProgress'),
    ('ActivationHistory-Gate', 'temporal:ReadRecovery'),
    ('ActivationHistory-Commit', 'CurrentHistory'),
    ('ActivationHistory-Buffer', 'BufferOwner'),
    ('ActivationHistory-Requests', 'RequestConserved'),
    ('ActivationHistory-Dispatch', 'CommandAdmission'),
    ('ActivationHistory-Replay', 'NoReplay'),
    ('ActivationHistory-Cancel', 'IntentPreserved'),
    ('ActivationHistory-NoFairness', 'temporal:ReadRecovery'),
    ('SnapshotCut', None),
    ('SnapshotCut-Lifecycle', 'CanonicalCut'),
    ('SnapshotCut-Requests', 'RequestConserved'),
    ('SnapshotCut-NoFairness', 'temporal:ReadProgress'),
    ('ExecutionChannels', None),
    ('ExecutionChannels-Settings', 'LiveMetadata'),
    ('ExecutionChannels-ACK', 'LiveMetadata'),
    ('ExecutionChannels-Cancel', 'NativeConserved'),
    ('ExecutionChannels-Handler', 'RetiredHandler'),
    ('ExecutionChannels-Cleanup', 'SuccessorOwner'),
    ('ExecutionChannels-Gate', 'temporal:NativeProgress'),
    ('ExecutionChannels-NoFairness', 'temporal:NativeProgress'),
    ('StopControl', None),
    ('StopControl-History', 'temporal:StopProgress'),
    ('StopControl-Prompt', 'temporal:StopProgress'),
    ('StopControl-Fence', 'StopAdmission'),
    ('StopControl-Target', 'ExactTarget'),
    ('StopControl-Replay', 'NoDuplicateStop'),
    ('StopControl-Slot', 'NoDuplicateStop'),
    ('StopControl-NoFairness', 'temporal:StopProgress'),
    ('ProjectionNotifications', None),
    ('ProjectionNotifications-Global', 'NativeObserved'),
    ('ProjectionNotifications-Peer', 'PeerIndependent'),
    ('ProjectionNotifications-Replay', 'NoNativeReplay'),
    ('ProjectionNotifications-Retired', 'ProjectionLease'),
    ('ProjectionNotifications-Generation', 'ProjectionLease'),
    ('ProjectionNotifications-Drop', 'ProjectionConserved'),
    ('ProjectionNotifications-NoFairness', 'temporal:NativeProgress'),
    ('ResourceAvailability', None),
    ('ResourceAvailability-ACK', 'NativeAuthority'),
    ('ResourceAvailability-Wake', 'temporal:RestorationProgress'),
    ('ResourceAvailability-Duplicate', 'IdempotentAvailability'),
    ('ResourceAvailability-Demand', 'ReadNeedsDemand'),
    ('ResourceAvailability-NoFairness', 'temporal:RestorationProgress'),
    ('NotificationFanout', None),
    ('NotificationFanout-Live', 'AdmittedOnly'),
    ('NotificationFanout-Late', 'AdmittedOnly'),
    ('NotificationFanout-Incarnation', 'RetirementOwnership'),
    ('NotificationFanout-Physical', 'PhysicalOwnership'),
    ('NotificationFanout-Token', 'TokenOwnership'),
    ('NotificationFanout-Repeat', 'AtMostOnce'),
    ('NotificationFanout-Drop', 'Conservation'),
    ('NotificationFanout-NoFairness', 'temporal:FanoutTermination'),
    ('ObserverAdmission', None),
    ('ObserverAdmission-Live', 'AdmittedOnly'),
    ('ObserverAdmission-Incarnation', 'RegistrationOwnership'),
    ('ObserverAdmission-Token', 'TokenOwnership'),
    ('ObserverAdmission-Clear', 'ClearRevokes'),
    ('ObserverAdmission-Repeat', 'AtMostOnce'),
    ('ObserverAdmission-Drop', 'Conservation'),
    ('ObserverAdmission-NoFairness', 'temporal:ObserverTermination'),

]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", required=True, type=Path, help="Official TLA+ v1.8.0 tla2tools.jar")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    jar = args.jar.resolve()
    if hashlib.sha256(jar.read_bytes()).hexdigest() != TLC_SHA256:
        raise SystemExit("Unexpected TLC hash; use the exact documented release asset")
    spec = Path(__file__).resolve().parent
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    def source_hashes():
        return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(spec.iterdir()) if p.suffix in {".tla", ".cfg", ".py"}}
    before = source_hashes()
    results = []
    for config, violation in CASES:
        trace = output / (config + "-trace.json")
        trace.unlink(missing_ok=True)
        with tempfile.TemporaryDirectory(prefix="recovery-tlc-") as temporary:
            command = ["java", "-Xmx512m", "-XX:+UseParallelGC", "-cp", str(jar), "tlc2.TLC",
                "-workers", "1", "-fp", "0", "-noGenerateSpecTE", "-metadir", temporary,
                "-dumpTrace", "json", str(trace), "-config", config + ".cfg", config.split("-")[0] + ".tla"]
            try:
                run = subprocess.run(command, cwd=spec, capture_output=True, text=True, timeout=120)
                log, code = run.stdout + run.stderr, run.returncode
            except subprocess.TimeoutExpired as error:
                log = "TLC exceeded the 120s verification budget\n"
                code = -1
        (output / (config + ".log")).write_text(log)
        if violation is None:
            ok = code == 0 and "Model checking completed. No error has been found." in log
        elif violation.startswith("temporal:"):
            name = violation.split(":", 1)[1]
            ok = code == 13 and f"Error: Temporal property {name} was violated." in log
        else:
            ok = code == 12 and f"Error: Invariant {violation} is violated." in log
        if violation is not None:
            ok = ok and trace.is_file()
        if config == "Recovery-HoldGate" and trace.is_file():
            terminal = json.loads(trace.read_text())["counterexample"]["state"][-1][1]["s"]
            ok = ok and terminal["net"] and terminal["socket"] == 2 and terminal["barrier"]["a"]
            ok = ok and terminal["phase"]["a"] == "dial" and terminal["token"]["a"] == 2
            ok = ok and terminal["gate"]["a"] == 1 and terminal["baseline"] == 0
        if config == "ActivationHistory-Gate" and trace.is_file():
            terminal = json.loads(trace.read_text())["counterexample"]["state"][-1][1]["s"]
            ok = ok and terminal["epoch"] == 1 and not terminal["readDone"]
            ok = ok and terminal["activation"] == "pending" and terminal["intent"]
        if config == "ActivationHistory-StrategyGate" and trace.is_file():
            terminal = json.loads(trace.read_text())["counterexample"]["state"][-1][1]["s"]
            ok = ok and terminal["epoch"] == 1 and terminal["readDone"]
            ok = ok and terminal["activation"] == "ready" and not terminal["oldHistory"]
            ok = ok and terminal["sends"] == 0 and terminal["intent"]
        counts = re.findall(r"([\d,]+) states generated, ([\d,]+) distinct states found", log)
        result = {"config": config, "exit": code, "passed": ok, "expectedViolation": violation}
        if counts:
            result.update(generated=int(counts[-1][0].replace(",", "")),
                distinct=int(counts[-1][1].replace(",", "")))
        results.append(result)
        print(json.dumps(result), flush=True)
    hashes = source_hashes()
    stable = hashes == before
    (output / "results.json").write_text(json.dumps({"cases": results,
        "sha256": hashes, "tlcJarSha256": TLC_SHA256, "sourceStable": stable}, indent=2) + "\n")
    if not stable or not all(result["passed"] for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
