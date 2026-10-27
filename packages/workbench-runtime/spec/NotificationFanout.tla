---------------------- MODULE NotificationFanout ----------------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLE s
vars == <<s>>
Consumers == {"a", "b"}
Tokens == Consumers \X (1..2)
Live(registry) == {t \in Tokens : registry[t[1]] = t[2]}
Init == s = [registry |-> [c \in Consumers |-> 1],
  issued |-> [c \in Consumers |-> 1], emitted |-> FALSE,
  admission |-> {}, pending |-> {}, settled |-> {},
  counts |-> [t \in Tokens |-> 0], gateOpen |-> FALSE,
  alive |-> TRUE, epoch |-> 0, captured |-> 0, lostOnce |-> FALSE,
  badAdmission |-> FALSE, badRetirement |-> FALSE,
  badConnection |-> FALSE, badToken |-> FALSE]
Wire == /\ ~s.emitted /\ s.alive
  /\ s' = [s EXCEPT !.emitted = TRUE, !.captured = s.epoch,
    !.admission = Live(s.registry), !.pending = Live(s.registry)]
Replace(c) == /\ s.issued[c] = 1
  /\ s' = [s EXCEPT !.issued[c] = 2, !.registry[c] = 2,
    !.pending = IF s.emitted /\ Fault = "live"
      THEN @ \cup {<<c, 2>>} ELSE @]
Unsubscribe(c) == /\ s.registry[c] # 0
  /\ s' = [s EXCEPT !.registry[c] = 0]
OldToken(c) == /\ s.registry[c] = 2
  /\ s' = [s EXCEPT !.registry[c] = IF Fault = "token" THEN 0 ELSE @,
    !.badToken = @ \/ Fault = "token"]
Release == /\ ~s.gateOpen
  /\ LET live == Live(s.registry)
     IN s' = [s EXCEPT !.gateOpen = TRUE,
       !.pending = IF s.emitted /\ Fault = "late-admission" THEN live ELSE @,
       !.settled = IF s.emitted /\ Fault = "late-admission"
         THEN @ \cup (s.pending \ live) ELSE @]
Lose == /\ s.alive /\ ~s.lostOnce
  /\ s' = [s EXCEPT !.alive = FALSE, !.lostOnce = TRUE]
Reconnect == /\ ~s.alive /\ s.epoch = 0
  /\ s' = [s EXCEPT !.alive = TRUE, !.epoch = 1]
Process(t) == /\ s.gateOpen /\ t \in s.pending
  /\ LET active == t \in Live(s.registry)
         connected == s.alive /\ s.captured = s.epoch
         deliver == (active \/ Fault = "incarnation")
                     /\ (connected \/ Fault = "physical")
     IN s' = [s EXCEPT
       !.pending = IF Fault = "repeat" /\ deliver /\ s.counts[t] = 0
         THEN @ ELSE @ \ {t},
       !.settled = IF Fault = "drop" THEN @ ELSE @ \cup {t},
       !.counts[t] = IF deliver THEN @ + 1 ELSE @,
       !.badAdmission = @ \/ (deliver /\ t \notin s.admission),
       !.badRetirement = @ \/ (deliver /\ ~active),
       !.badConnection = @ \/ (deliver /\ ~connected)]
ProcessAny == \E t \in Tokens : Process(t)
Next == Wire \/ Release \/ Lose \/ Reconnect \/ ProcessAny
  \/ (\E c \in Consumers : Replace(c) \/ Unsubscribe(c) \/ OldToken(c))
SafetySpec == Init /\ [][Next]_vars
\* Callbacks and admitted continuations eventually return. There is no
\* fairness assumption that reconnect or a retired subscription comes back.
FairSpec == SafetySpec /\ WF_vars(Wire) /\ WF_vars(Release) /\ WF_vars(ProcessAny)
TypeOK == /\ s.registry \in [Consumers -> 0..2]
  /\ s.issued \in [Consumers -> 1..2]
  /\ s.admission \subseteq Tokens /\ s.pending \subseteq Tokens
  /\ s.settled \subseteq Tokens /\ s.counts \in [Tokens -> 0..2]
  /\ s.epoch \in 0..1 /\ s.captured \in 0..1
AdmittedOnly == ~s.badAdmission
RetirementOwnership == ~s.badRetirement
PhysicalOwnership == ~s.badConnection
TokenOwnership == ~s.badToken
AtMostOnce == \A t \in Tokens : s.counts[t] <= 1
Conservation == s.admission \subseteq s.pending \cup s.settled
FanoutTermination == s.emitted ~> (s.pending = {})
=============================================================================
