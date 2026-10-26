-------------------- MODULE ProjectionNotifications --------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLE s
vars == <<s>>
Init == s = [emitted |-> FALSE, readHeld |-> TRUE, queued |-> FALSE,
  active |-> TRUE, epoch |-> 0, captured |-> 0, native |-> 0,
  peer |-> 0, projected |-> 0, badProjection |-> FALSE, lost |-> FALSE]
Current == s.active /\ s.captured = s.epoch
Wire == /\ ~s.emitted
  /\ s' = [s EXCEPT !.emitted = TRUE, !.captured = s.epoch,
    !.native = IF Fault = "global" /\ s.readHeld THEN 0 ELSE 1,
    !.peer = IF Fault \in {"global", "peer"} /\ s.readHeld THEN 0 ELSE 1,
    !.queued = s.active /\ s.readHeld,
    !.projected = IF s.active /\ ~s.readHeld THEN 1 ELSE 0]
\* Read fairness is intentionally absent. Only the historical consumer may wait.
ReleaseRead == /\ s.readHeld
  /\ LET admitted == (s.active \/ Fault = "retired")
                      /\ (s.captured = s.epoch \/ Fault = "generation")
     IN s' = [s EXCEPT !.readHeld = FALSE, !.queued = FALSE,
       !.native = IF s.emitted /\ Fault = "global" THEN 1
         ELSE IF s.emitted /\ Fault = "replay" THEN @ + 1 ELSE @,
       !.peer = IF s.emitted /\ Fault \in {"global", "peer"} THEN 1 ELSE @,
       !.projected = IF s.queued /\ admitted /\ Fault # "drop" THEN 1 ELSE @,
       !.badProjection = @ \/ (s.queued /\ admitted /\ ~Current),
       !.lost = @ \/ (s.queued /\ Current /\ Fault = "drop")]
CancelRead == /\ s.readHeld /\ s' = [s EXCEPT !.readHeld = FALSE, !.queued = FALSE]
Unsubscribe == /\ s.active /\ s' = [s EXCEPT !.active = FALSE]
Reconnect == /\ s.epoch = 0 /\ s' = [s EXCEPT !.epoch = 1]
Next == Wire \/ ReleaseRead \/ CancelRead \/ Unsubscribe \/ Reconnect
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(Wire)
TypeOK == /\ s.emitted \in BOOLEAN /\ s.readHeld \in BOOLEAN /\ s.queued \in BOOLEAN
  /\ s.active \in BOOLEAN /\ s.epoch \in 0..1 /\ s.captured \in 0..1
  /\ s.native \in 0..2 /\ s.peer \in 0..1 /\ s.projected \in 0..1
  /\ s.badProjection \in BOOLEAN /\ s.lost \in BOOLEAN
NativeObserved == s.emitted => s.native >= 1
PeerIndependent == s.emitted => s.peer = 1
NoNativeReplay == s.native <= 1
ProjectionLease == ~s.badProjection
ProjectionConserved == ~s.lost
NativeProgress == <>(s.emitted /\ s.native = 1)
=============================================================================
