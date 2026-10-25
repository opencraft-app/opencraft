------------------------- MODULE HistoryReentry -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS RegisterAfterObserve, UncheckedProgress, UnfencedCommit,
          ClearAfterObserve, UnfencedBackoff, UnfencedCleanup
VARIABLE s
vars == <<s>>
Boundaries == {"admission", "history", "commit", "invalidate", "backoff"}
Init == \E boundary \in Boundaries, retained \in BOOLEAN :
  /\ (retained => boundary = "backoff")
  /\ s = [boundary |-> boundary, pc |-> "before",
        owner |-> IF boundary \in {"admission", "invalidate"} THEN 0 ELSE 1,
        slot |-> IF boundary = "admission" THEN 0 ELSE 1,
        pending |-> {1}, settled |-> IF boundary = "invalidate" THEN {1} ELSE {},
        disposed |-> FALSE, crashed |-> FALSE, retryTicket |-> IF retained THEN 1 ELSE 0,
        retryWanted |-> retained, timer |-> 0]

Before == /\ s.pc = "before"
  /\ s' = [s EXCEPT !.pc = "observer",
    !.owner = IF s.boundary = "admission" /\ ~RegisterAfterObserve THEN 1 ELSE @,
    !.slot = IF s.boundary = "invalidate" /\ ~ClearAfterObserve THEN 0 ELSE @]

\* Observer actions call public owner methods synchronously. Replacement
\* invalidates the old generation, then admits and reserves successor work.
Observe == /\ s.pc = "observer"
  /\ \E action \in {"none", "remove", "dispose", "replace", "retry"} :
    /\ (action = "retry" => s.boundary = "backoff")
    /\ LET retires == action \in {"remove", "dispose", "replace"}
       IN s' = [s EXCEPT !.pc = "after",
         !.owner = IF action = "replace" THEN 2 ELSE IF retires THEN 0 ELSE @,
         !.slot = IF action = "replace" THEN 2 ELSE IF action \in {"dispose", "remove"} THEN 0 ELSE @,
         !.pending = IF action = "replace" THEN @ \cup {2} ELSE @,
         !.settled = IF retires /\ s.owner = 1 THEN @ \cup {1} ELSE @,
         !.disposed = action = "dispose",
         !.retryTicket = IF action = "retry" THEN 1 ELSE @,
         !.retryWanted = IF retires THEN FALSE ELSE @ \/ action = "retry"]

After == /\ s.pc = "after"
  /\ s' = [s EXCEPT !.pc = "cleanup",
    !.owner = CASE s.boundary = "admission" /\ RegisterAfterObserve -> 1
      [] s.boundary = "commit" /\ (s.owner = 1 \/ UnfencedCommit) -> 0
      [] OTHER -> @,
    !.settled = IF s.boundary = "commit" /\ (s.owner = 1 \/ UnfencedCommit) THEN @ \cup {1} ELSE @,
    !.slot = IF s.boundary = "invalidate" /\ ClearAfterObserve THEN 0 ELSE @,
    !.crashed = s.boundary = "history" /\ UncheckedProgress /\ s.owner = 0,
    !.timer = IF s.boundary = "backoff"
      /\ ((s.owner = 1 /\ ~s.disposed /\ s.retryTicket = 0) \/ UnfencedBackoff) THEN 1 ELSE @]

Cleanup == /\ s.pc = "cleanup"
  /\ s' = [s EXCEPT !.pc = "done", !.slot = IF @ = 1 \/ UnfencedCleanup THEN 0 ELSE @]
RetryTick == /\ s.timer = 1 /\ s' = [s EXCEPT !.timer = 0]
FinishOld == /\ s.pc = "done" /\ s.owner = 1 /\ ~s.disposed /\ s.timer = 0
  /\ s' = [s EXCEPT !.owner = 0, !.settled = @ \cup {1}]
FinishNew == /\ s.owner = 2 /\ s.slot = 2 /\ ~s.disposed
  /\ s' = [s EXCEPT !.owner = 0, !.slot = 0, !.settled = @ \cup {2}]
Next == Before \/ Observe \/ After \/ Cleanup \/ RetryTick \/ FinishOld \/ FinishNew
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(Before) /\ WF_vars(Observe) /\ WF_vars(After)
  /\ WF_vars(Cleanup) /\ WF_vars(RetryTick) /\ WF_vars(FinishOld) /\ WF_vars(FinishNew)
TypeOK == /\ s.boundary \in Boundaries /\ s.pc \in {"before", "observer", "after", "cleanup", "done"}
  /\ s.owner \in 0..2 /\ s.slot \in 0..2 /\ s.pending \subseteq {1,2} /\ s.settled \subseteq s.pending
  /\ s.disposed \in BOOLEAN /\ s.crashed \in BOOLEAN /\ s.retryTicket \in 0..1
  /\ s.retryWanted \in BOOLEAN /\ s.timer \in 0..1
DisposalSettles == s.disposed => s.pending \subseteq s.settled
SafeProgressRead == ~s.crashed
SuccessorWorkOwner == 2 \in s.pending \ s.settled => s.owner = 2
SuccessorSlotOwner == 2 \in s.pending \ s.settled => s.slot = 2
ImmediateRetry == (s.retryWanted /\ s.owner = 1 /\ ~s.disposed) => s.timer = 0
NoLostWaiter == (s.pc = "done" /\ s.owner = 0) => s.pending \subseteq s.settled
HistoryTermination == <>(s.pc = "done" /\ s.pending \subseteq s.settled)
=============================================================================
