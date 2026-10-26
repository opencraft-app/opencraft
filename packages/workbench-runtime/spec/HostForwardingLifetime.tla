---------------------- MODULE HostForwardingLifetime ----------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal, FairCurrent
VARIABLE s
vars == <<s>>
Init == s = [owner |-> 1, live |-> TRUE, observed |-> TRUE,
 oldIssued |-> FALSE, oldWait |-> "none", oldNativeDone |-> FALSE,
 oldHandled |-> FALSE, oldAdmissions |-> 0, retired |-> FALSE,
 stopping |-> FALSE, physicalClosed |-> FALSE, wanted |-> FALSE,
 newIssued |-> FALSE, newOwner |-> 0, newNativeDone |-> FALSE,
 newOutcome |-> "none", blocked |-> FALSE, newLost |-> FALSE]
IssueOld == /\ s.owner = 1 /\ s.live /\ ~s.oldIssued
 /\ s' = [s EXCEPT !.oldIssued = TRUE, !.oldWait = "pending", !.oldAdmissions = 1]
Retire(stopping) == /\ s.owner = 1 /\ s.live /\ s.oldIssued
 /\ s' = [s EXCEPT !.live = FALSE, !.retired = TRUE, !.stopping = stopping]
Observe == /\ s.retired /\ s.observed
 /\ s' = [s EXCEPT !.observed = FALSE]
PhysicalClose == /\ s.stopping /\ ~s.physicalClosed
 /\ s' = [s EXCEPT !.physicalClosed = TRUE]
Renew == /\ s.retired /\ s.owner = 1
 /\ (~s.stopping \/ s.physicalClosed \/ Fault = "barrier")
 /\ s' = [s EXCEPT !.owner = 2, !.live = TRUE,
      !.blocked = Fault = "reuse-aborted",
      !.oldAdmissions = IF Fault = "replay" THEN @ + 1 ELSE @]
WantNew == /\ s.oldIssued /\ ~s.wanted
 /\ s' = [s EXCEPT !.wanted = TRUE]
CancelOld == /\ s.oldWait = "pending"
 /\ (s.retired \/ Fault = "live-cancel")
 /\ Fault # "wait-old-ack"
 /\ (Fault # "observed" \/ ~s.observed)
 /\ (Fault # "stop" \/ ~s.stopping)
 /\ s' = [s EXCEPT !.oldWait = "settled"]
OldNativeReply == /\ s.oldIssued /\ ~s.oldNativeDone
 /\ s' = [s EXCEPT !.oldNativeDone = TRUE]
OldCompletion == /\ s.oldNativeDone /\ ~s.oldHandled
 /\ s' = [s EXCEPT !.oldHandled = TRUE, !.oldWait = "settled",
      !.newLost = Fault = "cleanup" /\ s.newIssued /\ s.newOutcome = "pending"]
IssueNew == /\ s.wanted /\ s.owner = 2 /\ s.live
 /\ s.oldWait = "settled" /\ ~s.blocked /\ ~s.newIssued
 /\ s' = [s EXCEPT !.newIssued = TRUE, !.newOutcome = "pending",
      !.newOwner = IF Fault = "captured-old" THEN 1 ELSE s.owner]
NewNativeReply == /\ s.newIssued /\ ~s.newNativeDone
 /\ s' = [s EXCEPT !.newNativeDone = TRUE]
NewCompletion == /\ s.newNativeDone /\ s.newOutcome = "pending" /\ ~s.newLost
 /\ s' = [s EXCEPT !.newOutcome = "settled"]
Next == IssueOld \/ Retire(FALSE) \/ Retire(TRUE) \/ Observe \/ PhysicalClose
 \/ Renew \/ WantNew \/ CancelOld \/ OldNativeReply \/ OldCompletion
 \/ IssueNew \/ NewNativeReply \/ NewCompletion
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(CancelOld) /\ WF_vars(IssueNew)
      /\ WF_vars(NewCompletion) ELSE TRUE)
 /\ (IF FairCurrent THEN WF_vars(NewNativeReply) ELSE TRUE)
TypeOK == /\ s.owner \in {1, 2} /\ s.newOwner \in {0, 1, 2}
 /\ s.oldWait \in {"none", "pending", "settled"}
 /\ s.newOutcome \in {"none", "pending", "settled"}
 /\ s.oldAdmissions \in 0..2
LiveWriteWait == (s.oldWait = "settled") => (s.retired \/ s.oldNativeDone)
NoReplay == s.oldAdmissions <= 1
CompletionOwned == ~s.newLost
FreshNativeOwner == (s.owner = 2 /\ s.live) => ~s.blocked
NativeAdmissionOwned == s.newIssued => (s.newOwner = s.owner)
PhysicalBarrier == (s.stopping /\ s.owner = 2) => s.physicalClosed
LocalWaitProgress == s.retired ~> (s.oldWait = "settled")
SuccessorInitProgress == (s.wanted /\ s.owner = 2 /\ s.live) ~> (s.newOutcome = "settled")
=============================================================================
