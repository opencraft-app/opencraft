------------------------- MODULE ViewReadLease -------------------------
EXTENDS Naturals
CONSTANTS ProtectAcquire, ReadSelfPins, CancelWithPeer, ClearBaseline
VARIABLE s
vars == <<s>>
ViewDemand == s.pending + s.views + s.observers > 0
Init == s = [pending |-> 0, views |-> 0, observers |-> 0, alive |-> FALSE,
  baseline |-> FALSE, read |-> FALSE, command |-> FALSE,
  lostDemand |-> FALSE, lostRead |-> FALSE]
Acquire == /\ s.pending + s.views < 2
  /\ s' = [s EXCEPT !.pending = @ + 1]
Publish == /\ s.pending > 0 /\ ~s.alive
  /\ s' = [s EXCEPT !.alive = TRUE, !.baseline = TRUE]
Admit == /\ s.pending > 0 /\ s.alive
  /\ s' = [s EXCEPT !.pending = @ - 1, !.views = @ + 1]
Subscribe == /\ s.alive /\ s.views > 0 /\ s.observers = 0
  /\ s' = [s EXCEPT !.observers = 1]
Read == /\ s.alive /\ s.views + s.observers > 0 /\ ~s.read
  /\ s' = [s EXCEPT !.read = TRUE]
Command == /\ s.alive /\ s.views > 0 /\ ~s.command
  /\ s' = [s EXCEPT !.command = TRUE]
FinishRead == /\ s.read /\ s' = [s EXCEPT !.read = FALSE]
FinishCommand == /\ s.command /\ s' = [s EXCEPT !.command = FALSE]
Release == /\ s.views > 0
  /\ LET demand == s.pending + s.views - 1 + s.observers > 0
         cancel == s.read /\ ((~demand /\ ~ReadSelfPins) \/ CancelWithPeer)
     IN s' = [s EXCEPT !.views = @ - 1,
       !.read = IF cancel THEN FALSE ELSE @,
       !.baseline = IF cancel /\ ClearBaseline THEN FALSE ELSE @,
       !.lostRead = @ \/ (cancel /\ demand)]
Unsubscribe == /\ s.observers > 0
  /\ LET demand == s.pending + s.views > 0
         cancel == s.read /\ ~demand /\ ~ReadSelfPins
     IN s' = [s EXCEPT !.observers = 0,
       !.read = IF cancel THEN FALSE ELSE @,
       !.baseline = IF cancel /\ ClearBaseline THEN FALSE ELSE @]
Evict == /\ s.alive /\ s.views + s.observers = 0 /\ ~s.command
  /\ (~ProtectAcquire \/ s.pending = 0) /\ (~ReadSelfPins \/ ~s.read)
  /\ s' = [s EXCEPT !.alive = FALSE, !.baseline = FALSE, !.read = FALSE,
    !.lostDemand = @ \/ ViewDemand]
Next == Acquire \/ Publish \/ Admit \/ Subscribe \/ Read \/ Command \/ FinishRead
  \/ FinishCommand \/ Release \/ Unsubscribe \/ Evict
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(Publish) /\ WF_vars(Admit)
TypeOK == /\ s.pending \in 0..2 /\ s.views \in 0..2 /\ s.pending + s.views <= 2
  /\ s.observers \in 0..1 /\ s.alive \in BOOLEAN /\ s.baseline \in BOOLEAN
  /\ s.read \in BOOLEAN /\ s.command \in BOOLEAN
  /\ s.lostDemand \in BOOLEAN /\ s.lostRead \in BOOLEAN
AcquireProtected == ~s.lostDemand
ReadHasDemand == s.read => ViewDemand
PeerReadPreserved == ~s.lostRead
CachedBaseline == s.alive => s.baseline
CommandProtected == s.command => s.alive
AcquireProgress == (s.pending > 0) ~> (s.views > 0)
=============================================================================
