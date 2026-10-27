------------------------ MODULE HydrationHandoff ------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS HoldBinding, HoldSession, StaleCommit, StaleCleanup, LateSettlement
VARIABLE s
vars == <<s>>
Threads == {"a", "b"}
Init == s = [rev |-> [t \in Threads |-> 1],
  binding |-> [t \in Threads |-> 1], session |-> [t \in Threads |-> 1],
  pc |-> [t \in Threads |-> 0], settledOld |-> [t \in Threads |-> FALSE],
  repliedOld |-> [t \in Threads |-> FALSE], authority |-> [t \in Threads |-> 0]]

\* Revocation may occur independently per Thread on the same client generation.
\* Old RPC/strategy completion is deliberately NOT weakly fair.
Revoke(t) == /\ s.rev[t] = 1
  /\ s' = [s EXCEPT !.rev[t] = 2,
    !.binding[t] = IF HoldBinding THEN @ ELSE 0,
    !.session[t] = IF HoldSession THEN @ ELSE 0,
    !.settledOld[t] = ~LateSettlement]
StartBinding(t) == /\ s.rev[t] = 2 /\ s.pc[t] = 0 /\ s.binding[t] = 0
  /\ s' = [s EXCEPT !.pc[t] = 1, !.binding[t] = 2]
StartSession(t) == /\ s.pc[t] = 1 /\ s.session[t] = 0
  /\ s' = [s EXCEPT !.pc[t] = 2, !.session[t] = 2]
NewReply(t) == /\ s.pc[t] = 2
  /\ s' = [s EXCEPT !.pc[t] = 3]
Commit(t) == /\ s.pc[t] = 3 /\ s.binding[t] = 2 /\ s.session[t] = 2
  /\ s' = [s EXCEPT !.pc[t] = 4, !.authority[t] = 2]
Finish(t) == /\ s.pc[t] = 4
  /\ s' = [s EXCEPT !.pc[t] = 5, !.binding[t] = 0, !.session[t] = 0]
OldReply(t) == /\ s.rev[t] = 2 /\ ~s.repliedOld[t]
  /\ s' = [s EXCEPT !.repliedOld[t] = TRUE, !.settledOld[t] = TRUE,
    !.authority[t] = IF StaleCommit THEN 1 ELSE @,
    !.binding[t] = IF @ = 1 \/ StaleCleanup THEN 0 ELSE @,
    !.session[t] = IF @ = 1 \/ StaleCleanup THEN 0 ELSE @]
Next == \E t \in Threads : Revoke(t) \/ StartBinding(t) \/ StartSession(t)
  \/ NewReply(t) \/ Commit(t) \/ Finish(t) \/ OldReply(t)
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ \A t \in Threads : WF_vars(Revoke(t))
  /\ WF_vars(StartBinding(t)) /\ WF_vars(StartSession(t))
  /\ WF_vars(NewReply(t)) /\ WF_vars(Commit(t)) /\ WF_vars(Finish(t))
TypeOK == /\ s.rev \in [Threads -> 1..2] /\ s.binding \in [Threads -> 0..2]
  /\ s.session \in [Threads -> 0..2] /\ s.pc \in [Threads -> 0..5]
  /\ s.settledOld \in [Threads -> BOOLEAN] /\ s.repliedOld \in [Threads -> BOOLEAN]
  /\ s.authority \in [Threads -> 0..2]
CurrentAuthority == \A t \in Threads : s.authority[t] = 0 \/ s.authority[t] = s.rev[t]
CancelledWaiterSettles == \A t \in Threads : s.rev[t] = 2 => s.settledOld[t]
SuccessorSlots == \A t \in Threads :
  /\ (s.pc[t] \in 1..4 => s.binding[t] = 2)
  /\ (s.pc[t] \in 2..4 => s.session[t] = 2)
HydrationRecovery == <>(\A t \in Threads : s.pc[t] = 5 /\ s.authority[t] = 2)
=============================================================================
