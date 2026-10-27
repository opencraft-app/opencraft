-------------------------- MODULE ReplayLifetime --------------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal, FairClock
VARIABLE s
vars == <<s>>
Init == \E mode \in {"active", "connecting"}:
 s = [mode |-> mode, owner |-> 1, phase |-> IF mode = "active" THEN "open" ELSE "connecting",
  oldOpenDone |-> mode = "active", closeFinished |-> FALSE, explicitClose |-> FALSE, oldRetired |-> FALSE,
  cursor |-> IF mode = "active" THEN 1 ELSE 0,
  oldClaim |-> IF mode = "active" THEN "waiting" ELSE "none",
  oldConsumed |-> 0, oldClock |-> FALSE, oldWakeDone |-> FALSE,
  oldDelivered |-> FALSE, oldSettled |-> mode # "active", callerAborted |-> FALSE,
  newAsked |-> FALSE, newOpened |-> FALSE, newSent |-> FALSE,
  newClaim |-> FALSE, newClock |-> FALSE, newDelivered |-> FALSE,
  staleDelivered |-> FALSE, earlyMatched |-> FALSE]
OpenOld == /\ ~s.oldOpenDone
 /\ s' = [s EXCEPT !.oldOpenDone = TRUE,
   !.owner = IF ~s.oldRetired \/ Fault = "resurrect" THEN 1 ELSE @,
   !.phase = IF ~s.oldRetired \/ Fault = "resurrect" THEN "open" ELSE @]
CloseOld == /\ ~s.explicitClose /\ ~s.newOpened
 /\ LET claimed == s.oldClaim = "waiting"
        consume == claimed /\ Fault # "reservation"
        duplicate == s.oldClaim = "done" /\ Fault = "double"
    IN s' = [s EXCEPT !.explicitClose = TRUE, !.oldRetired = TRUE,
      !.owner = 0, !.phase = "closing",
      !.oldSettled = IF Fault = "wait-clock" /\ claimed THEN @ ELSE TRUE,
      !.oldClaim = IF claimed THEN "retired" ELSE @,
      !.cursor = IF consume \/ duplicate THEN @ + 1 ELSE @,
      !.oldConsumed = IF consume \/ duplicate THEN @ + 1 ELSE @]
FinishClose == /\ s.explicitClose /\ ~s.closeFinished
 /\ s' = [s EXCEPT !.closeFinished = TRUE,
    !.phase = IF s.owner = 0 \/ Fault = "close-owner" THEN "closed" ELSE @]
CancelCaller == /\ s.mode = "active" /\ ~s.explicitClose /\ ~s.callerAborted
 /\ s.owner = 1 /\ s.oldClaim = "waiting"
 /\ s' = [s EXCEPT !.callerAborted = TRUE, !.oldSettled = TRUE,
    !.owner = IF Fault = "caller" THEN 0 ELSE @,
    !.phase = IF Fault = "caller" THEN "closed" ELSE @]
MatureLiveOld == /\ s.oldClaim = "waiting" /\ s.owner = 1 /\ ~s.oldClock
 /\ s' = [s EXCEPT !.oldClock = TRUE]
MatureRetiredOld == /\ s.oldClaim = "retired" /\ ~s.oldClock
 /\ s' = [s EXCEPT !.oldClock = TRUE]
RunOld == /\ s.oldClock /\ ~s.oldWakeDone
 /\ LET live == s.owner = 1 /\ ~s.oldRetired
        stale == ~live /\ s.phase = "open" /\ Fault = "epoch"
        advance == ~live /\ Fault = "cursor"
    IN s' = [s EXCEPT !.oldWakeDone = TRUE, !.oldSettled = TRUE,
      !.oldDelivered = IF live THEN TRUE ELSE @,
      !.oldClaim = IF live THEN "done" ELSE @,
      !.oldConsumed = IF live THEN @ + 1 ELSE @,
      !.cursor = IF live \/ advance THEN @ + 1 ELSE @,
      !.staleDelivered = stale]
TryLaterClient == /\ s.mode = "active" /\ s.owner = 1 /\ s.oldClaim = "waiting"
 /\ ~s.earlyMatched /\ Fault = "early"
 /\ s' = [s EXCEPT !.earlyMatched = TRUE]
AskNew == /\ s.explicitClose /\ ~s.newAsked
 /\ s' = [s EXCEPT !.newAsked = TRUE]
OpenNew == /\ s.newAsked /\ ~s.newOpened /\ s.oldRetired
 /\ s' = [s EXCEPT !.owner = 2, !.phase = "open", !.newOpened = TRUE]
SendNew == /\ s.mode = "active" /\ s.newOpened /\ ~s.newSent /\ s.cursor = 2
 /\ s' = [s EXCEPT !.newSent = TRUE, !.cursor = 3, !.newClaim = TRUE]
MatureNew == /\ s.newClaim /\ ~s.newClock
 /\ s' = [s EXCEPT !.newClock = TRUE]
RunNew == /\ s.newClaim /\ s.newClock /\ s.cursor = 3 /\ s.owner = 2
 /\ s' = [s EXCEPT !.newClaim = FALSE, !.newDelivered = TRUE, !.cursor = 4]
Next == OpenOld \/ CloseOld \/ FinishClose \/ CancelCaller \/ MatureLiveOld \/ MatureRetiredOld
 \/ RunOld \/ TryLaterClient \/ AskNew \/ OpenNew \/ SendNew \/ MatureNew \/ RunNew
LocalWork == /\ WF_vars(FinishClose) /\ WF_vars(OpenOld) /\ WF_vars(RunOld) /\ WF_vars(OpenNew)
 /\ WF_vars(SendNew) /\ WF_vars(RunNew)
CurrentClock == /\ WF_vars(MatureLiveOld) /\ WF_vars(MatureNew)
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN LocalWork ELSE TRUE)
 /\ (IF FairClock THEN CurrentClock ELSE TRUE)
TypeOK == /\ s.owner \in 0..2 /\ s.cursor \in 0..5
 /\ s.phase \in {"open", "closed", "closing", "connecting"}
 /\ s.oldClaim \in {"none", "waiting", "retired", "done"} /\ s.oldConsumed \in 0..2
CursorBounds == s.cursor <= 4
CurrentFrameOwner == ~s.staleDelivered
ClaimConsumed == (s.mode = "active" /\ s.oldRetired) => s.oldConsumed = 1
AtMostOnce == s.oldConsumed <= 1
NoEarlyAdmission == ~s.earlyMatched
SuccessorNativeState == s.newOpened => (s.owner = 2 /\ s.phase = "open")
NoResurrection == s.oldRetired => s.owner # 1
CallerNotNative == (s.callerAborted /\ ~s.explicitClose) => s.owner = 1
LocalCompletion == (s.mode = "active" /\ s.oldRetired) ~> s.oldSettled
SuccessorCompletion == (s.mode = "active" /\ s.newAsked) ~> s.newDelivered
CallerFrameProgress == s.callerAborted ~> (s.oldDelivered \/ s.explicitClose)
=============================================================================
