---------------- MODULE HostLogicalNativeRecovery ----------------
EXTENDS Naturals
CONSTANTS Outcome, Fault, FairLocal, FairPhysical
VARIABLE s
vars == <<s>>
Init == s = [nativeOpen |-> FALSE, logicalFailed |-> TRUE, intent |-> TRUE,
 phase |-> "idle", oldResource |-> TRUE, newResource |-> FALSE, owner |-> 1,
 cleanupStarted |-> FALSE, result |-> "pending", caller |-> "pending", late |-> FALSE]
Begin == /\ s.phase = "idle" /\ s.intent /\ ~s.cleanupStarted
 /\ ~s.nativeOpen /\ (Fault # "logical-blocks-recovery" \/ ~s.logicalFailed)
 /\ s' = [s EXCEPT !.phase = "closing", !.cleanupStarted = TRUE]
ProviderSuccess == /\ s.phase = "closing" /\ s.result = "pending" /\ Outcome = "success"
 /\ s' = [s EXCEPT !.result = "success", !.oldResource = FALSE]
ProviderFailure == /\ s.phase = "closing" /\ s.result = "pending" /\ Outcome = "failure"
 /\ s' = [s EXCEPT !.result = "failure"]
Provider == ProviderSuccess \/ ProviderFailure
Finish == /\ s.phase = "closing" /\ s.result # "pending"
 /\ s' = [s EXCEPT !.phase = IF s.result = "success" THEN "released" ELSE "failed",
   !.owner = IF s.result = "success" THEN 0 ELSE @,
   !.logicalFailed = IF s.result = "success" THEN FALSE ELSE @,
   !.caller = IF s.result = "failure" THEN "rejected" ELSE @]
Replace == /\ s.phase = "released" /\ s.owner = 0
 /\ s' = [s EXCEPT !.phase = "open", !.owner = 2, !.newResource = TRUE,
   !.nativeOpen = TRUE, !.caller = "resolved"]
TrustLabel == /\ Fault = "trust-label" /\ ~s.nativeOpen /\ s.phase = "idle"
 /\ s' = [s EXCEPT !.phase = "released", !.owner = 0]
OldLogicalCompletion == /\ s.owner = 2 /\ ~s.late
 /\ s' = [s EXCEPT !.late = TRUE, !.owner = IF Fault = "retarget" THEN 0 ELSE @]
Next == Begin \/ Provider \/ Finish \/ Replace \/ TrustLabel \/ OldLogicalCompletion
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(Begin) /\ WF_vars(Finish) /\ WF_vars(Replace) ELSE TRUE)
 /\ (IF FairPhysical THEN WF_vars(Provider) ELSE TRUE)
TypeOK == /\ s.owner \in 0..2 /\ s.phase \in {"idle", "closing", "released", "failed", "open"}
HandleConserved == s.oldResource => s.owner = 1
NoOverlap == ~(s.oldResource /\ s.newResource)
CurrentOwner == s.newResource => s.owner = 2
FailedOwned == s.phase = "failed" => (s.owner = 1 /\ ~s.newResource)
RecoveryStarts == s.intent ~> s.cleanupStarted
CallerProgress == s.intent ~> (s.caller # "pending")
===================================================================
