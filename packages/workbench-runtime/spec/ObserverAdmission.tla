---------------------- MODULE ObserverAdmission ----------------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLE s
vars == <<s>>
Consumers == {"a", "b"}
Tokens == Consumers \X (1..2)
Live(registry) == {t \in Tokens : registry[t[1]] = t[2]}
Init == s = [registry |-> [c \in Consumers |-> 1],
  issued |-> [c \in Consumers |-> 1], emitted |-> FALSE,
  admission |-> {}, pending |-> {}, settled |-> {}, cleared |-> {},
  counts |-> [t \in Tokens |-> 0], badAdmission |-> FALSE,
  badRetirement |-> FALSE, badClear |-> FALSE, badToken |-> FALSE]
Emit == /\ ~s.emitted
  /\ s' = [s EXCEPT !.emitted = TRUE,
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
Clear == /\ Live(s.registry) # {}
  /\ s' = [s EXCEPT !.cleared = @ \cup Live(s.registry),
    !.registry = [c \in Consumers |-> 0]]
Process(t) == /\ t \in s.pending
  /\ LET active == t \in Live(s.registry)
         deliver == active
           \/ (Fault = "incarnation" /\ s.registry[t[1]] = 2 /\ t \notin s.cleared)
           \/ (Fault = "clear" /\ t \in s.cleared)
     IN s' = [s EXCEPT
       !.pending = IF Fault = "repeat" /\ deliver /\ s.counts[t] = 0
         THEN @ ELSE @ \ {t},
       !.settled = IF Fault = "drop" THEN @ ELSE @ \cup {t},
       !.counts[t] = IF deliver THEN @ + 1 ELSE @,
       !.badAdmission = @ \/ (deliver /\ t \notin s.admission),
       !.badRetirement = @ \/ (deliver /\ ~active),
       !.badClear = @ \/ (deliver /\ t \in s.cleared),
       !.badToken = @]
ProcessAny == \E t \in Tokens : Process(t)
Next == Emit \/ Clear \/ ProcessAny
  \/ (\E c \in Consumers : Replace(c) \/ Unsubscribe(c) \/ OldToken(c))
SafetySpec == Init /\ [][Next]_vars
\* Observer callbacks terminate; there is no transport or initialization gate.
FairSpec == SafetySpec /\ WF_vars(Emit) /\ WF_vars(ProcessAny)
TypeOK == /\ s.registry \in [Consumers -> 0..2]
  /\ s.issued \in [Consumers -> 1..2]
  /\ s.admission \subseteq Tokens /\ s.pending \subseteq Tokens
  /\ s.settled \subseteq Tokens /\ s.cleared \subseteq Tokens
  /\ s.counts \in [Tokens -> 0..2]
AdmittedOnly == ~s.badAdmission
ClearRevokes == ~s.badClear
RegistrationOwnership == ~s.badRetirement
TokenOwnership == ~s.badToken
AtMostOnce == \A t \in Tokens : s.counts[t] <= 1
Conservation == s.admission \subseteq s.pending \cup s.settled
ObserverTermination == s.emitted ~> (s.pending = {})
=============================================================================
