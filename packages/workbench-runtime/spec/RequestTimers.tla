-------------------------- MODULE RequestTimers --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS IgnoreTimerRevision, IgnoreRequestIdentity
VARIABLE s
vars == <<s>>
Timer(request, revision, due) == [request |-> request, revision |-> revision, due |-> due]
Init == s = [request |-> 1, phase |-> "pending", now |-> 0,
  due |-> 1, revision |-> 0, extended |-> FALSE, shortened |-> FALSE,
  callbacks |-> {Timer(1, 0, 1)}, badEarly |-> FALSE, badOwner |-> FALSE]

Tick == /\ s.now < 5 /\ s' = [s EXCEPT !.now = @ + 1]
Extend == /\ s.phase = "pending" /\ ~s.extended /\ s.now < s.due
  /\ s' = [s EXCEPT !.due = 4, !.revision = 1, !.extended = TRUE,
    !.callbacks = @ \cup {Timer(s.request, 1, 4)}]
Shorten == /\ s.phase = "pending" /\ s.extended /\ ~s.shortened
  /\ s.now < s.due /\ s.now < 3
  /\ s' = [s EXCEPT !.due = s.now + 1, !.revision = 2, !.shortened = TRUE,
    !.callbacks = @ \cup {Timer(s.request, 2, s.now + 1)}]
Complete == /\ s.phase = "pending" /\ s' = [s EXCEPT !.phase = "complete"]
Successor == /\ s.request = 1 /\ s.phase # "pending" /\ s.now < 4
  /\ s' = [s EXCEPT !.request = 2, !.phase = "pending", !.due = s.now + 1,
    !.revision = 0, !.extended = FALSE, !.shortened = FALSE,
    !.callbacks = @ \cup {Timer(2, 0, s.now + 1)}]

\* Cleared callbacks remain possible deliveries, but cannot run before due.
Deliver(timer) == /\ timer \in s.callbacks /\ timer.due <= s.now
  /\ LET owner == timer.request = s.request
         current == owner /\ timer.revision = s.revision
         accepts == s.phase = "pending"
           /\ (owner \/ IgnoreRequestIdentity)
           /\ (timer.revision = s.revision \/ IgnoreTimerRevision)
     IN s' = [s EXCEPT !.callbacks = @ \ {timer},
       !.phase = IF accepts THEN "timeout" ELSE @,
       !.badEarly = @ \/ (accepts /\ s.now < s.due),
       !.badOwner = @ \/ (accepts /\ ~current)]
Next == Tick \/ Extend \/ Shorten \/ Complete \/ Successor
  \/ (\E timer \in s.callbacks : Deliver(timer))
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(Tick)
  /\ (\A timer \in [request : 1..2, revision : 0..2, due : 1..5] : WF_vars(Deliver(timer)))
TypeOK == /\ s.request \in 1..2 /\ s.phase \in {"pending", "complete", "timeout"}
  /\ s.now \in 0..5 /\ s.due \in 1..5 /\ s.revision \in 0..2
  /\ s.extended \in BOOLEAN /\ s.shortened \in BOOLEAN
  /\ s.callbacks \subseteq [request : 1..2, revision : 0..2, due : 1..5]
  /\ s.badEarly \in BOOLEAN /\ s.badOwner \in BOOLEAN
NoEarlyTimeout == ~s.badEarly
TimeoutOwnership == ~s.badOwner
RequestTermination == []<>(s.phase # "pending")
=============================================================================
