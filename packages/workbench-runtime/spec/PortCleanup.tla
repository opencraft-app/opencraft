-------------------------- MODULE PortCleanup --------------------------
EXTENDS Naturals
CONSTANTS Side, InitialFailure, Peer, Service, Fault, FairLocal, FairRepair
VARIABLE s
vars == <<s>>
Init == s = [begun |-> FALSE, retired |-> FALSE, settled |-> FALSE,
 terminal |-> 0, stage |-> "idle", complete |-> FALSE, healed |-> FALSE,
 retried |-> FALSE, removeOK |-> FALSE, closeOK |-> FALSE,
 removeHeld |-> TRUE, closeHeld |-> TRUE, removes |-> 0, closes |-> 0,
 removeSuccess |-> 0, closeSuccess |-> 0, reported |-> FALSE,
 native |-> FALSE, late |-> FALSE, lateAdmitted |-> FALSE]
Begin == /\ ~s.begun /\ s' = [s EXCEPT !.begun = TRUE]
Retire == /\ s.begun /\ ~s.retired
 /\ s' = [s EXCEPT !.retired = TRUE, !.stage = "remove",
 !.settled = Fault # "wait-after-port", !.terminal = 1]
RemoveFails == ~s.healed /\ InitialFailure \in {"remove", "both"}
CloseFails == ~s.healed /\ InitialFailure \in {"close", "both"}
Remove == /\ s.stage = "remove"
 /\ LET attempt == (~s.removeOK /\ s.removeHeld) \/ Fault = "repeat-success"
        failed == attempt /\ RemoveFails
     IN s' = [s EXCEPT !.stage = IF failed /\ Fault = "short-circuit" THEN "done" ELSE "close",
       !.removes = IF attempt THEN @ + 1 ELSE @,
       !.removeSuccess = IF attempt /\ ~failed THEN @ + 1 ELSE @,
       !.removeOK = @ \/ (attempt /\ ~failed),
       !.removeHeld = IF failed THEN Fault # "forget-handle" ELSE FALSE]
Close == /\ s.stage = "close"
 /\ LET attempt == (~s.closeOK /\ s.closeHeld) \/ Fault = "repeat-success"
        failed == attempt /\ CloseFails
     IN s' = [s EXCEPT !.stage = "done", !.closes = IF attempt THEN @ + 1 ELSE @,
       !.closeSuccess = IF attempt /\ ~failed THEN @ + 1 ELSE @,
       !.closeOK = @ \/ (attempt /\ ~failed),
       !.closeHeld = IF failed THEN Fault # "forget-handle" ELSE FALSE]
Finish == /\ s.stage = "done"
 /\ s' = [s EXCEPT !.stage = "idle", !.complete = TRUE,
   !.reported = (~s.removeOK \/ ~s.closeOK) /\ Fault # "swallow"]
NeedsNative == Side = "server" \/ (Side = "connection" /\ ~Peer /\ ~Service)
Native == /\ s.retired /\ ~s.native
 /\ (NeedsNative \/ Fault = "close-peer")
 /\ ~(Fault = "skip-native" /\ InitialFailure # "none")
 /\ s' = [s EXCEPT !.native = TRUE]
Heal == /\ s.retired /\ ~s.healed /\ s' = [s EXCEPT !.healed = TRUE]
Retry == /\ s.retired /\ s.stage = "idle" /\ s.healed /\ ~s.retried
 /\ s' = [s EXCEPT !.retried = TRUE, !.stage = "remove", !.complete = FALSE]
Late == /\ s.retired /\ ~s.late
 /\ s' = [s EXCEPT !.late = TRUE, !.lateAdmitted = Fault = "admit-late"]
Next == Begin \/ Retire \/ Remove \/ Close \/ Finish \/ Native \/ Heal \/ Retry \/ Late
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(Begin) /\ WF_vars(Retire) /\ WF_vars(Remove)
      /\ WF_vars(Close) /\ WF_vars(Finish) /\ WF_vars(Native) /\ WF_vars(Retry) ELSE TRUE)
 /\ (IF FairRepair THEN WF_vars(Heal) ELSE TRUE)
TypeOK == /\ s.stage \in {"idle", "remove", "close", "done"}
 /\ s.removes \in 0..2 /\ s.closes \in 0..2 /\ s.terminal \in 0..1
LocalSettlement == s.retired => s.settled
BothAttempted == s.complete => s.removes >= 1 /\ s.closes >= 1
HandleConserved == /\ ((s.retired /\ ~s.removeOK) => s.removeHeld)
 /\ ((s.retired /\ ~s.closeOK) => s.closeHeld)
SuccessOnce == s.removeSuccess <= 1 /\ s.closeSuccess <= 1
HonestFailure == s.complete => s.reported = (~s.removeOK \/ ~s.closeOK)
PeerProtected == s.native => NeedsNative
NoLateAdmission == ~s.lateAdmitted
LocalProgress == s.begun ~> s.retired
NativeProgress == (s.retired /\ NeedsNative) ~> s.native
PortProgress == s.retired ~> (s.removeOK /\ s.closeOK)
=============================================================================
