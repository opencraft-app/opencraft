------------------------- MODULE ClientRetirement -------------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal, FairNative
VARIABLE s
vars == <<s>>
Init == \E mode \in {"ready", "preconnected", "unseen"}:
 s = [mode |-> mode, raw |-> 1, rawState |-> IF mode = "unseen" THEN "closed" ELSE "open",
   retired |-> (mode = "unseen" \/ Fault = "constructor"),
   closeIssued |-> mode = "unseen", closingHandled |-> mode = "unseen",
   acked |-> mode = "unseen", closedQueued |-> FALSE, closedHandled |-> mode = "unseen",
   oldPending |-> mode # "ready", oldRPC |-> mode = "ready", oldAwaitDone |-> mode # "unseen",
   requested |-> FALSE, admitted |-> FALSE, slot |-> IF mode = "ready" THEN 0 ELSE 1,
   stage |-> IF mode = "ready" THEN "empty" ELSE IF mode = "unseen" THEN "native" ELSE "preparing",
   future |-> "absent", activity |-> FALSE, newLoss |-> FALSE, newLossHandled |-> FALSE]
CancelCurrent(x, cause) == [x EXCEPT
  !.oldPending = IF x.slot = 1 THEN FALSE ELSE @,
  !.future = IF x.slot = 2 /\ @ = "pending" THEN cause
             ELSE IF x.slot = 1 /\ @ = "joined-old" THEN "old-loss" ELSE @,
  !.slot = 0, !.stage = "empty"]
Close == /\ ~s.closeIssued /\ s.raw = 1
  /\ s' = [s EXCEPT !.closeIssued = TRUE, !.rawState = "closing"]
HandleClosing == /\ s.closeIssued /\ ~s.closingHandled
  /\ LET base == IF ~s.retired THEN CancelCurrent(s, "old-loss") ELSE s
     IN s' = [base EXCEPT !.retired = TRUE, !.closingHandled = TRUE,
                !.oldRPC = IF Fault = "first-cleanup" THEN @ ELSE FALSE]
AckOld == /\ s.closeIssued /\ ~s.acked
  /\ s' = [s EXCEPT !.acked = TRUE,
    !.rawState = IF s.raw = 1 THEN "closed" ELSE @,
    !.closedQueued = s.raw = 1]
HandleClosed == /\ s.closedQueued /\ ~s.closedHandled /\ s.closingHandled
  /\ LET base == IF ~s.retired \/ Fault = "repeat" THEN CancelCurrent(s, "old-loss") ELSE s
     IN s' = [base EXCEPT !.retired = TRUE, !.closedHandled = TRUE, !.oldRPC = FALSE]
Request2 == /\ s.closeIssued /\ ~s.requested
  /\ s' = [s EXCEPT !.requested = TRUE, !.future = "pending"]
AdmitLocal2 == /\ s.requested /\ ~s.admitted
  /\ (s.closingHandled \/ Fault = "eager")
  /\ LET joinsOld == s.slot = 1 /\ s.oldPending
         fence == joinsOld /\ s.stage = "native" /\ s.rawState \in {"closing", "closed", "failed"} /\ Fault # "join"
     IN s' = IF joinsOld /\ ~fence THEN [s EXCEPT !.admitted = TRUE, !.future = "joined-old"]
       ELSE [s EXCEPT !.admitted = TRUE, !.oldPending = IF fence THEN FALSE ELSE @,
              !.slot = 2, !.stage = "preparing"]
CatchOld == /\ s.mode = "unseen" /\ ~s.oldAwaitDone
  /\ LET clears == s.slot = 1 \/ Fault = "stale-catch"
     IN s' = [s EXCEPT !.oldAwaitDone = TRUE, !.oldPending = FALSE,
              !.slot = IF clears THEN 0 ELSE @, !.stage = IF clears THEN "empty" ELSE @,
              !.future = IF @ = "joined-old" THEN "old-loss" ELSE @]
BeginNative2 == /\ s.admitted /\ s.closingHandled /\ s.slot = 2 /\ s.stage = "preparing"
  /\ s' = [s EXCEPT !.raw = 2, !.rawState = "connecting", !.stage = "native"]
ObserveActivity2 == /\ s.raw = 2 /\ s.stage = "native" /\ ~s.activity
  /\ (~s.closedQueued \/ s.closedHandled)
  /\ s' = [s EXCEPT !.activity = TRUE, !.retired = IF Fault = "rearm" THEN @ ELSE FALSE]
Finish2 == /\ s.raw = 2 /\ s.slot = 2 /\ s.stage = "native" /\ s.activity /\ ~s.newLoss
  /\ s' = [s EXCEPT !.stage = "ready", !.future = "ready", !.rawState = "open", !.retired = FALSE]
LoseNew == /\ s.raw = 2 /\ s.stage = "native" /\ s.activity /\ ~s.newLoss
  /\ s' = [s EXCEPT !.newLoss = TRUE, !.rawState = "failed"]
HandleNewLoss == /\ s.newLoss /\ ~s.newLossHandled
  /\ LET base == IF ~s.retired THEN CancelCurrent(s, "new-loss") ELSE s
     IN s' = [base EXCEPT !.retired = TRUE, !.newLossHandled = TRUE]
Next == Close \/ HandleClosing \/ AckOld \/ HandleClosed \/ Request2 \/ AdmitLocal2 \/ CatchOld
  \/ BeginNative2 \/ ObserveActivity2 \/ Finish2 \/ LoseNew \/ HandleNewLoss
LocalWork == /\ WF_vars(HandleClosing) /\ WF_vars(HandleClosed) /\ WF_vars(AdmitLocal2)
  /\ WF_vars(CatchOld) /\ WF_vars(BeginNative2) /\ WF_vars(ObserveActivity2) /\ WF_vars(HandleNewLoss)
Spec == Init /\ [][Next]_vars
  /\ (IF FairLocal THEN LocalWork ELSE TRUE)
  /\ (IF FairNative THEN WF_vars(Finish2) ELSE TRUE)
TypeOK == /\ s.raw \in 1..2 /\ s.slot \in 0..2
  /\ s.stage \in {"empty", "preparing", "native", "ready"}
  /\ s.future \in {"absent", "pending", "joined-old", "old-loss", "new-loss", "ready"}
OldRequestsRetired == s.closingHandled => ~s.oldRPC
InitialActivityRetired == (s.mode = "preconnected" /\ s.closingHandled) => ~s.oldPending
NewActivityRetired == s.newLossHandled => s.future = "new-loss"
FutureOutcome == s.requested ~> (s.future \in {"ready", "new-loss"})
OldCompletion == (s.mode = "unseen") ~> ~s.oldPending
=============================================================================
