------------------------- MODULE DerivedHistory -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS LateDependency, SilentRetire, UnfencedCleanup, PropagateCancel
VARIABLE s
vars == <<s>>
Jobs == 1..3
Kinds == {"older", "refresh"}
Kind(j) == IF j = 2 THEN "refresh" ELSE "older"
Other(j) == IF Kind(j) = "older" THEN "refresh" ELSE "older"
Active(j) == s.phase[j] \in {"admitted", "waiting", "running"}
Init == s = [next |-> 1, slot |-> [k \in Kinds |-> 0],
  phase |-> [j \in Jobs |-> "new"], predecessor |-> [j \in Jobs |-> 0],
  settled |-> [j \in Jobs |-> FALSE], explicitCancel |-> {},
  oldReply |-> [j \in Jobs |-> FALSE]]
Admit(j) == /\ j = s.next /\ s.slot[Kind(j)] = 0
  /\ s' = [s EXCEPT !.next = @ + 1, !.slot[Kind(j)] = j,
    !.phase[j] = "admitted", !.predecessor[j] = s.slot[Other(j)]]
Prepare(j) == /\ s.phase[j] = "admitted"
  /\ s' = [s EXCEPT !.phase[j] = "waiting",
    !.predecessor[j] = IF LateDependency THEN s.slot[Other(j)] ELSE @]
Ready(j) == /\ s.phase[j] = "waiting"
  /\ (IF s.predecessor[j] = 0 THEN TRUE ELSE s.settled[s.predecessor[j]])
  /\ LET losesIntent == IF PropagateCancel /\ s.predecessor[j] # 0
        THEN s.phase[s.predecessor[j]] = "retired" ELSE FALSE
     IN s' = [s EXCEPT !.phase[j] = IF losesIntent THEN "retired" ELSE "running",
       !.settled[j] = losesIntent,
       !.slot[Kind(j)] = IF losesIntent THEN 0 ELSE @]
Complete(j) == /\ s.phase[j] = "running"
  /\ s' = [s EXCEPT !.phase[j] = "done", !.settled[j] = TRUE, !.slot[Kind(j)] = 0]
Cancel(j) == /\ Active(j)
  /\ s' = [s EXCEPT !.phase[j] = "retired", !.explicitCancel = @ \cup {j},
    !.settled[j] = ~SilentRetire, !.slot[Kind(j)] = 0]
\* Remote work may ignore cancellation forever; no fairness on OldReply.
OldReply(j) == /\ s.phase[j] = "retired" /\ ~s.oldReply[j]
  /\ s' = [s EXCEPT !.oldReply[j] = TRUE, !.settled[j] = TRUE,
    !.slot[Kind(j)] = IF @ = j \/ UnfencedCleanup THEN 0 ELSE @]
Next == \E j \in Jobs : Admit(j) \/ Prepare(j) \/ Ready(j) \/ Complete(j) \/ Cancel(j) \/ OldReply(j)
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ \A j \in Jobs : WF_vars(Prepare(j)) /\ WF_vars(Ready(j)) /\ WF_vars(Complete(j))
TypeOK == /\ s.next \in 1..4 /\ s.slot \in [Kinds -> 0..3]
  /\ s.phase \in [Jobs -> {"new", "admitted", "waiting", "running", "done", "retired"}]
  /\ s.predecessor \in [Jobs -> 0..3] /\ s.settled \in [Jobs -> BOOLEAN]
  /\ s.explicitCancel \subseteq Jobs /\ s.oldReply \in [Jobs -> BOOLEAN]
NoFutureDependency == \A j \in Jobs : s.predecessor[j] < j
RetiredSettles == \A j \in Jobs : s.phase[j] = "retired" => s.settled[j]
CurrentSlots == \A j \in Jobs : Active(j) => s.slot[Kind(j)] = j
IndependentIntent == \A j \in Jobs : s.phase[j] = "retired" => j \in s.explicitCancel
DerivedTermination == \A j \in Jobs : (s.phase[j] # "new") ~> s.settled[j]
=============================================================================
