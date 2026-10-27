---------------------- MODULE InteractionReplyOwner ----------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Scenario, ReplayState, Outcome, Fault, FairValidation, FairWriter
Attempts == {1, 2}
VARIABLE s
vars == <<s>>
Init == s = [entry |-> 1, owner |-> 0, state |-> "pending", expected |-> "pending",
  validation |-> "idle", writes |-> {}, done |-> {}, replayed |-> FALSE,
  replaced |-> FALSE, badAdmission |-> FALSE, badPublication |-> FALSE,
  caller |-> [a \in Attempts |-> "idle"], captured |-> [a \in Attempts |-> 0]]
Start == /\ s.validation = "idle"
 /\ s' = [s EXCEPT !.validation = "validating", !.caller[1] = "pending", !.captured[1] = s.entry]
Peer == /\ Scenario = "validation" /\ s.validation = "validating"
 /\ s.owner = 0 /\ 2 \notin s.writes
 /\ s' = [s EXCEPT !.owner = 2, !.state = "responding", !.expected = "responding",
   !.writes = @ \cup {2}, !.caller[2] = "pending", !.captured[2] = s.entry]
Replace == /\ Scenario = "replace" /\ s.validation = "validating" /\ ~s.replaced
 /\ s' = [s EXCEPT !.entry = 2, !.replaced = TRUE, !.owner = 0,
   !.state = "pending", !.expected = "pending"]
ValidateReturn == /\ s.validation = "validating"
 /\ (Scenario # "validation" \/ 2 \in s.writes)
 /\ (Scenario # "replace" \/ s.replaced)
 /\ LET replaced == s.captured[1] # s.entry
        claimed == s.state # "pending"
        writes == ~replaced /\ (~claimed \/ Fault = "duplicate")
    IN s' = [s EXCEPT !.validation = "done",
      !.writes = IF writes THEN @ \cup {1} ELSE @,
      !.owner = IF writes THEN 1 ELSE @,
      !.state = IF writes THEN "responding" ELSE @,
      !.expected = IF writes /\ ~claimed THEN "responding" ELSE @,
      !.badAdmission = @ \/ (writes /\ claimed),
      !.badPublication = @ \/ (replaced /\ Fault = "publish-retired"),
      !.caller[1] = IF writes THEN "pending" ELSE IF replaced THEN "resolved" ELSE "already-submitted"]
Replay == /\ Scenario = "replay" /\ 1 \in s.writes /\ ~s.replayed
 /\ s' = [s EXCEPT !.replayed = TRUE, !.state = ReplayState, !.expected = ReplayState,
   !.owner = IF ReplayState = "pending" THEN 0 ELSE @]
NewAnswer == /\ Scenario = "replay" /\ s.replayed /\ s.state = "pending" /\ 2 \notin s.writes
 /\ s' = [s EXCEPT !.owner = 2, !.state = "responding", !.expected = "responding",
   !.writes = @ \cup {2}, !.caller[2] = "pending", !.captured[2] = s.entry]
WriterFinish(a) == /\ a \in s.writes \ s.done
 /\ LET current == s.captured[a] = s.entry /\ s.owner = a
        broken == s.captured[a] = s.entry /\ (Fault = "entry-only" \/ (Fault = "text-token" /\ s.owner # 0))
        failed == Outcome = "failure"
    IN s' = [s EXCEPT !.done = @ \cup {a},
      !.state = IF failed /\ (current \/ broken) THEN "unconfirmed" ELSE @,
      !.expected = IF failed /\ current THEN "unconfirmed" ELSE @,
      !.caller[a] = IF failed /\ Fault # "swallow" THEN "rejected" ELSE "submitted"]
Next == Start \/ Peer \/ Replace \/ ValidateReturn \/ Replay \/ NewAnswer
 \/ (\E a \in Attempts: WriterFinish(a))
Spec == Init /\ [][Next]_vars
 /\ (IF FairValidation THEN WF_vars(Peer) /\ WF_vars(Replace) /\ WF_vars(ValidateReturn) ELSE TRUE)
 /\ (IF FairWriter THEN \A a \in Attempts: WF_vars(WriterFinish(a)) ELSE TRUE)
TypeOK == /\ s.owner \in 0..2 /\ s.entry \in 1..2 /\ s.writes \subseteq Attempts
 /\ s.done \subseteq s.writes /\ s.state \in {"pending", "responding", "unconfirmed"}
CurrentState == s.state = s.expected
SingleAdmission == ~s.badAdmission
PublicationOwner == ~s.badPublication
CallerOutcome == \A a \in s.done: s.caller[a] = IF Outcome = "failure" THEN "rejected" ELSE "submitted"
ValidationProgress == (s.validation = "validating") ~> (s.validation = "done")
WriterProgress == \A a \in Attempts: (a \in s.writes) ~> (a \in s.done)
=======================================================================
