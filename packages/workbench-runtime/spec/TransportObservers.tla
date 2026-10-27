---------------------- MODULE TransportObservers ----------------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLE s
vars == <<s>>
Versions == 1..3
Tokens == {<<"a",1>>, <<"a",2>>, <<"b",1>>}
Live(registry) == {t \in Tokens : registry[t[1]] = t[2]}
Drained == \A v \in Versions : s.pending[v] = {}
Init == s = [registry |-> [a |-> 1, b |-> 1], issued |-> 1,
  opened |-> FALSE, aborted |-> FALSE, lost |-> FALSE, successor |-> FALSE,
  requested |-> FALSE, newInit |-> "absent", rpcIssued |-> FALSE,
  current |-> 0, connect |-> "pending",
  admission |-> [v \in Versions |-> {}], pending |-> [v \in Versions |-> {}],
  processed |-> [v \in Versions |-> {}], counts |-> [v \in Versions |-> [t \in Tokens |-> 0]],
  abandoned |-> FALSE, rpcPending |-> FALSE, badException |-> FALSE,
  badToken |-> FALSE, badAdmission |-> FALSE, badVersion |-> FALSE]
NativeOpen == /\ ~s.opened /\ ~s.aborted
  /\ s' = [s EXCEPT !.opened = TRUE, !.current = 1,
    !.connect = IF Fault = "orphan" THEN @ ELSE "resolved",
    !.admission[1] = Live(s.registry), !.pending[1] = Live(s.registry)]
ReserveRead == /\ s.opened /\ s.current = 1 /\ s.connect = "resolved" /\ ~s.rpcIssued
  /\ s' = [s EXCEPT !.rpcIssued = TRUE, !.rpcPending = TRUE]
NativeClose == /\ s.opened /\ s.current = 1
  /\ s' = [s EXCEPT !.current = 2, !.lost = TRUE,
    !.admission[2] = Live(s.registry), !.pending[2] = Live(s.registry),
    !.registry = IF Fault = "clear" THEN [a |-> 0, b |-> 0] ELSE @]
Abort == /\ ~s.opened /\ ~s.aborted
  /\ s' = [s EXCEPT !.aborted = TRUE, !.current = 2,
    !.connect = "rejected", !.rpcPending = FALSE,
    !.admission[2] = Live(s.registry), !.pending[2] = Live(s.registry)]
ObservedTerminalA == \E t \in Tokens : t[1] = "a" /\ s.counts[2][t] > 0
BeginSuccessor == /\ s.opened /\ s.current = 2 /\ ObservedTerminalA
  /\ s' = [s EXCEPT !.successor = TRUE, !.current = 3,
    !.admission[3] = Live(s.registry), !.pending[3] = Live(s.registry)]
RequestClient == /\ s.lost /\ ObservedTerminalA /\ ~s.requested
  /\ s' = [s EXCEPT !.requested = TRUE,
    !.newInit = IF Fault = "eager-init" THEN "pending" ELSE @]
AdmitClient == /\ s.requested /\ s.newInit = "absent" /\ Drained
  /\ s' = [s EXCEPT !.newInit = "pending", !.successor = TRUE, !.current = 3,
    !.admission[3] = IF s.current = 2 THEN Live(s.registry) ELSE @,
    !.pending[3] = IF s.current = 2 THEN Live(s.registry) ELSE @]
AckClient == /\ s.newInit = "pending" /\ Drained
  /\ s' = [s EXCEPT !.newInit = "ready"]
Replace == /\ s.issued = 1
  /\ s' = [s EXCEPT !.issued = 2, !.registry.a = 2,
    !.pending = IF Fault = "live" /\ s.current \in Versions /\ s.pending[s.current] # {}
      THEN [@ EXCEPT ![s.current] = @ \cup {<<"a",2>>}] ELSE @]
Unsubscribe == /\ s.registry.a # 0 /\ s' = [s EXCEPT !.registry.a = 0]
OldToken == /\ s.registry.a = 2
  /\ s' = [s EXCEPT !.registry.a = IF Fault = "token" THEN 0 ELSE @,
    !.badToken = @ \/ Fault = "token"]
Process(v,t) == /\ t \in s.pending[v]
  /\ (\A prior \in Versions : prior < v => s.pending[prior] = {})
  /\ LET deliver == t \in Live(s.registry)
           /\ (v = s.current \/ (v = 2 /\ Fault # "terminal") \/ Fault = "stale")
         escapes == deliver /\ t[1] = "a" /\ Fault \in {"exception", "orphan"}
     IN s' = [s EXCEPT
       !.pending[v] = IF escapes THEN {} ELSE IF Fault = "repeat" /\ deliver /\ s.counts[v][t] = 0
         THEN @ ELSE @ \ {t},
       !.processed[v] = @ \cup {t},
       !.counts[v][t] = IF deliver THEN @ + 1 ELSE @,
       !.abandoned = @ \/ (escapes /\ v = 1),
       !.badException = @ \/ escapes,
       !.badAdmission = @ \/ (deliver /\ t \notin s.admission[v]),
       !.badVersion = @ \/ (deliver /\ v # s.current /\ v # 2),
       !.rpcPending = IF deliver /\ v = 2 /\ t[1] = "b" /\ Fault # "loss" THEN FALSE ELSE @,
       !.newInit = IF deliver /\ v = 2 /\ t[1] = "b" /\ @ = "pending" THEN "cancelled" ELSE @]
ProcessAny == \E v \in Versions, t \in Tokens : Process(v,t)
Complete == /\ s.opened /\ s.connect = "pending" /\ ~s.abandoned /\ s.pending[1] = {}
  /\ s' = [s EXCEPT !.connect = "resolved"]
Next == NativeOpen \/ ReserveRead \/ NativeClose \/ Abort \/ BeginSuccessor \/ RequestClient \/ AdmitClient \/ AckClient
  \/ Replace \/ Unsubscribe \/ OldToken \/ ProcessAny \/ Complete
SafetySpec == Init /\ [][Next]_vars
NoInitFairSpec == SafetySpec /\ WF_vars(NativeOpen) /\ WF_vars(ProcessAny) /\ WF_vars(Complete) /\ WF_vars(AdmitClient)
FairSpec == NoInitFairSpec /\ WF_vars(AckClient)
TypeOK == /\ s.registry \in [a:0..2, b:0..1] /\ s.issued \in 1..2
  /\ s.opened \in BOOLEAN /\ s.aborted \in BOOLEAN /\ s.current \in 0..3
  /\ s.connect \in {"pending", "resolved", "rejected"} /\ s.newInit \in {"absent", "pending", "cancelled", "ready"}
  /\ s.admission \in [Versions -> SUBSET Tokens] /\ s.pending \in [Versions -> SUBSET Tokens]
  /\ s.processed \in [Versions -> SUBSET Tokens] /\ s.counts \in [Versions -> [Tokens -> 0..2]]
ObserverIsolation == ~s.badException
TokenOwnership == ~s.badToken
AdmittedOnly == ~s.badAdmission
CurrentPublication == ~s.badVersion
AtMostOnce == \A v \in Versions, t \in Tokens : s.counts[v][t] <= 1
Conservation == \A v \in Versions : s.admission[v] \subseteq s.pending[v] \cup s.processed[v]
InitAdmission == s.newInit \in {"pending", "ready"} => ~s.rpcPending
ConnectCompletion == <>(s.connect # "pending")
FailureDelivery == s.lost ~> ~s.rpcPending
SuccessorReady == s.requested ~> (s.newInit = "ready")
=============================================================================
