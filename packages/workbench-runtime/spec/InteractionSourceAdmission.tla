-------------------- MODULE InteractionSourceAdmission --------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Boundary, Target, Fault, FairLocal, FairProducer
Threads == {"A", "B"}
VARIABLE s
vars == <<s>>
Init == s = [available |-> [t \in Threads |-> TRUE], state |-> "pending",
 begun |-> FALSE, peer |-> FALSE, revoked |-> FALSE, returned |-> FALSE,
 replayed |-> FALSE, retried |-> FALSE, writes |-> {}, validators |-> 0,
 result |-> "idle"]
Start == /\ ~s.begun
 /\ s' = [s EXCEPT !.begun = TRUE, !.result = "waiting"]
Peer == /\ s.begun /\ Boundary = "peer" /\ ~s.peer /\ ~s.revoked
 /\ s' = [s EXCEPT !.peer = TRUE, !.state = "responding", !.writes = {0}]
Revoke == /\ s.begun /\ ~s.revoked /\ (Boundary # "peer" \/ s.peer)
 /\ s' = [s EXCEPT !.revoked = TRUE,
   !.available = [t \in Threads |-> IF t = Target \/ Fault = "global" THEN FALSE ELSE s.available[t]]]
Return == /\ s.revoked /\ ~s.returned
 /\ LET allowed == s.available["A"]
        skipped == Fault = "skip-recheck"
        claim == ~s.peer /\ (allowed \/ skipped)
     IN s' = [s EXCEPT !.returned = TRUE,
       !.state = IF claim THEN "responding" ELSE @,
       !.writes = IF claim /\ allowed THEN @ \cup {1} ELSE @,
       !.validators = IF Boundary # "fingerprint" \/ allowed \/ skipped \/ Fault = "validate-revoked" THEN 1 ELSE 0,
       !.result = IF ~allowed /\ ~skipped THEN "unavailable"
         ELSE IF s.peer THEN "already-submitted" ELSE IF allowed THEN "submitted" ELSE "source-changed"]
Replay == /\ s.returned /\ ~s.replayed
 /\ s' = [s EXCEPT !.replayed = TRUE,
   !.available[Target] = Fault # "drop-replay",
   !.state = IF Fault = "reopen-claim" THEN "pending" ELSE @]
Retry == /\ s.replayed /\ ~s.retried
 /\ s' = [s EXCEPT !.retried = TRUE,
   !.writes = IF s.available["A"] /\ s.state = "pending" THEN @ \cup {2} ELSE @,
   !.state = IF s.available["A"] /\ s.state = "pending" THEN "responding" ELSE @]
Next == Start \/ Peer \/ Revoke \/ Return \/ Replay \/ Retry
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(Peer) /\ WF_vars(Revoke) /\ WF_vars(Return) /\ WF_vars(Retry) ELSE TRUE)
 /\ (IF FairProducer THEN WF_vars(Replay) ELSE TRUE)
TypeOK == /\ s.available \in [Threads -> BOOLEAN]
 /\ s.state \in {"pending", "responding"} /\ s.writes \subseteq {0, 1, 2}
 /\ s.validators \in 0..1
ScopeIsolation == Target = "B" => s.available["A"]
NoEmptyClaim == (s.returned /\ s.state = "responding") => s.writes # {}
CallerClassification == s.returned =>
 s.result = IF Target = "A" THEN "unavailable" ELSE IF s.peer THEN "already-submitted" ELSE "submitted"
ValidationAuthority == (Boundary = "fingerprint" /\ Target = "A" /\ s.returned) => s.validators = 0
ReplayAuthority == s.replayed => s.available[Target]
AtMostOneWriter == Cardinality(s.writes) <= 1
CallerProgress == s.begun ~> s.returned
RecoveryProgress == (s.returned /\ Target = "A" /\ ~s.peer) ~> (2 \in s.writes)
=============================================================================
