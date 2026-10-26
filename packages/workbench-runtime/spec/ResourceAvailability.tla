---------------------- MODULE ResourceAvailability ----------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLE s
vars == <<s>>
\* One explicit restore transaction and its captured epoch; View demand is fixed.
Init == \E demand \in BOOLEAN : s = [availability |-> "archived", revision |-> 0,
  ack |-> FALSE, nativeRestore |-> FALSE, deleted |-> FALSE, wake |-> FALSE,
  readReady |-> FALSE, oldReadHeld |-> TRUE, demand |-> demand, extraEpoch |-> FALSE]
NativeRestore == /\ ~s.nativeRestore /\ ~s.deleted
  /\ LET transition == s.availability # "available"
         duplicate == ~transition /\ Fault = "duplicate"
     IN s' = [s EXCEPT !.nativeRestore = TRUE,
       !.availability = "available",
       !.revision = IF transition \/ duplicate THEN @ + 1 ELSE @,
       !.wake = IF transition \/ duplicate THEN Fault # "wake" ELSE @,
       !.extraEpoch = @ \/ duplicate]
Ack == /\ ~s.ack
  /\ s' = [s EXCEPT !.ack = TRUE,
    !.availability = IF s.revision = 0 \/ Fault = "ack" THEN "available" ELSE @,
    !.revision = IF s.revision = 0 \/ Fault = "ack" THEN @ + 1 ELSE @,
    !.wake = IF s.revision = 0 \/ Fault = "ack" THEN Fault # "wake" ELSE @]
Delete == /\ ~s.deleted
  /\ s' = [s EXCEPT !.availability = "deleted", !.revision = @ + 1,
    !.deleted = TRUE, !.wake = FALSE, !.readReady = FALSE]
Read == /\ s.wake /\ s.availability = "available"
  /\ (s.demand \/ Fault = "demand")
  /\ s' = [s EXCEPT !.readReady = TRUE, !.wake = FALSE]
OldReadReply == /\ s.oldReadHeld /\ s' = [s EXCEPT !.oldReadHeld = FALSE]
Next == NativeRestore \/ Ack \/ Delete \/ Read \/ OldReadReply
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(Ack) /\ WF_vars(Read)
TypeOK == /\ s.availability \in {"archived", "available", "deleted"}
  /\ s.revision \in 0..3 /\ s.ack \in BOOLEAN /\ s.nativeRestore \in BOOLEAN
  /\ s.deleted \in BOOLEAN /\ s.wake \in BOOLEAN /\ s.readReady \in BOOLEAN
  /\ s.oldReadHeld \in BOOLEAN /\ s.demand \in BOOLEAN /\ s.extraEpoch \in BOOLEAN
NativeAuthority == s.deleted => s.availability = "deleted"
CurrentRead == s.readReady => s.availability = "available"
ReadNeedsDemand == s.readReady => s.demand
IdempotentAvailability == ~s.extraEpoch
RestorationProgress == s.demand => <>(s.readReady \/ s.deleted)
=============================================================================
