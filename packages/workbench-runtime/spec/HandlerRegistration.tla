--------------------- MODULE HandlerRegistration ---------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLE s
vars == <<s>>
Init == s = [registry |-> 1, issued |-> 1, started |-> FALSE,
  admitted |-> 0, request |-> "idle", response |-> 0, closed |-> FALSE,
  badToken |-> FALSE, badRevoke |-> FALSE]
Replace == /\ ~s.closed /\ s.issued = 1
  /\ s' = [s EXCEPT !.issued = 2, !.registry = 2]
Unsubscribe(t) == /\ t \in 1..s.issued /\ s.registry # 0
  /\ LET remove == s.registry = t \/ Fault = "token"
         revoke == remove /\ s.request = "pending" /\ Fault = "cancel"
     IN s' = [s EXCEPT !.registry = IF remove THEN 0 ELSE @,
       !.badToken = @ \/ (remove /\ s.registry # t),
       !.badRevoke = @ \/ revoke,
       !.request = IF revoke THEN "retired" ELSE @]
Admit == /\ ~s.closed /\ ~s.started /\ s.registry # 0
  /\ s' = [s EXCEPT !.started = TRUE, !.admitted = s.registry, !.request = "pending"]
Finish == /\ s.request = "pending"
  /\ s' = [s EXCEPT !.request = "answered",
    !.response = IF Fault = "retarget" /\ s.registry # 0 THEN s.registry ELSE s.admitted]
Close == /\ ~s.closed
  /\ s' = [s EXCEPT !.closed = TRUE, !.registry = 0,
    !.request = IF @ = "pending" THEN "lost" ELSE @]
Next == Replace \/ Admit \/ Finish \/ Close \/ (\E t \in 1..2 : Unsubscribe(t))
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(Finish)
TypeOK == /\ s.registry \in 0..2 /\ s.issued \in 1..2
  /\ s.admitted \in 0..2 /\ s.response \in 0..2
  /\ s.request \in {"idle", "pending", "answered", "lost", "retired"}
  /\ s.started \in BOOLEAN /\ s.closed \in BOOLEAN
  /\ s.badToken \in BOOLEAN /\ s.badRevoke \in BOOLEAN
TokenOwnership == ~s.badToken
RegistrationDoesNotRevoke == ~s.badRevoke
ReplyOwner == s.response = 0 \/ s.response = s.admitted
RequestCompletion == (s.request = "pending") ~> (s.request \in {"answered", "lost"})
=============================================================================
