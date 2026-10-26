---------------------- MODULE HostDeliveryLifetime ----------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal, FairCurrentAck
VARIABLE s
vars == <<s>>
Init == s = [phase |-> "pending", acknowledged |-> FALSE,
 terminal |-> 0, native |-> TRUE, grant |-> FALSE, observed |-> FALSE,
 sent |-> FALSE, wait |-> "none", budget |-> FALSE, lost |-> FALSE, local |-> FALSE,
 peer |-> TRUE, checked |-> FALSE, falseReady |-> FALSE, staleSend |-> FALSE,
 successor |-> FALSE, successorAck |-> FALSE, successorReady |-> FALSE,
 cleaned |-> FALSE, damaged |-> FALSE]
PreTerminal(g) == /\ s.phase = "pending" /\ s.terminal = 0
 /\ s' = [s EXCEPT !.terminal = g]
OwnAck == /\ s.phase = "pending"
 /\ s' = [s EXCEPT !.acknowledged = TRUE,
      !.phase = IF s.terminal = 1 THEN "retired" ELSE "active",
      !.native = s.terminal # 1, !.grant = s.terminal # 1,
      !.observed = s.terminal # 1]
SharedOpen == /\ ~s.grant
 /\ Fault \in {"premature", "resurrect"}
 /\ (IF Fault = "premature" THEN s.phase = "pending" ELSE s.phase = "retired")
 /\ s' = [s EXCEPT !.grant = TRUE]
Send == /\ s.phase = "active" /\ ~s.sent
 /\ s' = [s EXCEPT !.sent = TRUE, !.wait = "pending", !.budget = TRUE]
NativeLoss == /\ s.phase = "active"
 /\ s' = [s EXCEPT !.phase = "retired", !.native = FALSE,
      !.grant = FALSE, !.lost = TRUE, !.budget = Fault = "budget" /\ s.budget]
LocalClose == /\ s.phase = "active"
 /\ s' = [s EXCEPT !.phase = "retired", !.grant = FALSE, !.local = TRUE,
      !.peer = Fault # "wide-retire", !.budget = Fault = "budget" /\ s.budget]
Observe == /\ s.phase = "retired" /\ s.observed
 /\ s' = [s EXCEPT !.observed = FALSE]
CheckReadiness == /\ s.phase = "retired" /\ ~s.checked
 /\ s' = [s EXCEPT !.checked = TRUE,
      !.falseReady = Fault = "observed" /\ s.observed]
TryRetiredSend == /\ s.phase = "retired" /\ ~s.staleSend
 /\ Fault = "send" /\ s.observed
 /\ s' = [s EXCEPT !.staleSend = TRUE]
CancelLocalWait == /\ s.phase = "retired" /\ s.wait = "pending"
 /\ Fault # "wait-old-ack"
 /\ s' = [s EXCEPT !.wait = "done"]
OldForwardingAck == /\ s.wait = "pending"
 /\ s' = [s EXCEPT !.wait = "done", !.budget = FALSE]
StartSuccessor == /\ s.phase = "retired" /\ ~s.successor /\ ~s.budget
 /\ s' = [s EXCEPT !.successor = TRUE]
CurrentOwnAck == /\ s.successor /\ ~s.successorAck
 /\ s' = [s EXCEPT !.successorAck = TRUE, !.successorReady = TRUE]
OldCleanup == /\ s.successorAck /\ ~s.cleaned
 /\ s' = [s EXCEPT !.cleaned = TRUE,
      !.damaged = Fault = "cleanup", !.successorReady = Fault # "cleanup"]
Next == PreTerminal(1) \/ PreTerminal(99) \/ OwnAck \/ SharedOpen \/ Send
 \/ NativeLoss \/ LocalClose \/ Observe \/ CheckReadiness \/ TryRetiredSend
 \/ CancelLocalWait \/ OldForwardingAck \/ StartSuccessor \/ CurrentOwnAck \/ OldCleanup
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(CancelLocalWait) ELSE TRUE)
 /\ (IF FairCurrentAck THEN WF_vars(CurrentOwnAck) ELSE TRUE)
TypeOK == /\ s.phase \in {"pending", "active", "retired"}
 /\ s.wait \in {"none", "pending", "done"}
OwnAcknowledgement == ~s.acknowledged => ~s.grant
NoResurrection == s.phase = "retired" => ~s.grant
NativeReadiness == ~s.falseReady
NativeSendAdmission == ~s.staleSend
RetiredBudgetReleased == s.phase = "retired" => ~s.budget
PeerIsolation == s.local => s.peer
SuccessorCleanup == ~s.damaged
RetiredWaitProgress == (s.phase = "retired" /\ s.sent) ~> (s.wait = "done")
CurrentAckProgress == s.successor ~> s.successorReady
=============================================================================
