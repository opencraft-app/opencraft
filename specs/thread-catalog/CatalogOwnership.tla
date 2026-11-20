------------------------ MODULE CatalogOwnership ------------------------
EXTENDS Integers, FiniteSets, TLC
CONSTANTS Keys, MaxCommits, LegacyAck, AcceptOldScope
VARIABLES scope, authority, commits, base, baseScope, overlay, floor,
          sequence, response, stable
vars == <<scope, authority, commits, base, baseScope, overlay, floor,
          sequence, response, stable>>
Epochs == {0, 1}
Unknown == [k \in Keys |-> -1]
NoResponse == [active |-> FALSE, epoch |-> 0, cut |-> Unknown, boundary |-> 0, complete |-> FALSE]
Effective(k) == IF overlay[k] >= 0 THEN overlay[k] ELSE base[k]
Converged == \A k \in Keys: Effective(k) = authority[scope][k] /\ baseScope[k] = scope
Init == /\ scope = 0 /\ authority = [e \in Epochs |-> [k \in Keys |-> 0]]
        /\ commits = 0 /\ base = Unknown /\ baseScope = Unknown
        /\ overlay = Unknown /\ floor = Unknown /\ sequence = 0
        /\ response = NoResponse /\ stable = FALSE
Commit(k) == /\ ~stable /\ commits < MaxCommits
             /\ authority' = [authority EXCEPT ![scope][k] = @ + 1]
             /\ commits' = commits + 1
             /\ UNCHANGED <<scope, base, baseScope, overlay, floor, sequence, response, stable>>
DeliverEvent(k) == /\ ~stable /\ authority[scope][k] > floor[k]
  /\ overlay' = [overlay EXCEPT ![k] = authority[scope][k]]
  /\ floor' = [floor EXCEPT ![k] = authority[scope][k]] /\ sequence' = sequence + 1
  /\ UNCHANGED <<scope, authority, commits, base, baseScope, response, stable>>
ReadStart == /\ ~stable /\ ~response.active
  /\ \E cut \in [Keys -> -1..MaxCommits], complete \in BOOLEAN:
       /\ \A k \in Keys: cut[k] <= authority[scope][k]
       /\ response' = [active |-> TRUE, epoch |-> scope, cut |-> cut, boundary |-> sequence, complete |-> complete]
  /\ UNCHANGED <<scope, authority, commits, base, baseScope, overlay, floor, sequence, stable>>
DeliverRead == /\ response.active
  /\ LET admitted == response.epoch = scope \/ AcceptOldScope
         accepted == {k \in Keys: admitted /\ response.cut[k] >= 0 /\ response.cut[k] >= base[k]}
     IN /\ base' = [k \in Keys |-> IF k \in accepted THEN response.cut[k] ELSE base[k]]
        /\ baseScope' = [k \in Keys |-> IF k \in accepted THEN response.epoch ELSE baseScope[k]]
        /\ overlay' = [k \in Keys |-> IF admitted /\ overlay[k] >= 0 /\
             (IF LegacyAck THEN response.boundary >= sequence
              ELSE response.epoch = scope /\ response.cut[k] >= overlay[k]) THEN -1 ELSE overlay[k]]
  /\ response' = NoResponse
  /\ UNCHANGED <<scope, authority, commits, floor, sequence, stable>>
SwitchScope == /\ ~stable /\ scope = 0 /\ scope' = 1
  /\ base' = Unknown /\ baseScope' = Unknown /\ overlay' = Unknown /\ floor' = Unknown /\ sequence' = 0
  /\ UNCHANGED <<authority, commits, response, stable>>
Quiesce == /\ ~stable /\ stable' = TRUE
  /\ UNCHANGED <<scope, authority, commits, base, baseScope, overlay, floor, sequence, response>>
Reconcile == /\ stable /\ ~Converged
  /\ base' = authority[scope] /\ baseScope' = [k \in Keys |-> scope] /\ overlay' = Unknown
  /\ UNCHANGED <<scope, authority, commits, floor, sequence, response, stable>>
Next == (\E k \in Keys: Commit(k) \/ DeliverEvent(k)) \/ ReadStart \/ DeliverRead \/ SwitchScope \/ Quiesce \/ Reconcile
SafetySpec == Init /\ [][Next]_vars
Spec == SafetySpec /\ WF_vars(Quiesce) /\ WF_vars(Reconcile)
TypeOK == /\ scope \in Epochs /\ commits \in 0..MaxCommits
          /\ authority \in [Epochs -> [Keys -> 0..MaxCommits]] /\ stable \in BOOLEAN
          /\ baseScope \in [Keys -> -1..1]
          /\ base \in [Keys -> -1..MaxCommits] /\ overlay \in [Keys -> -1..MaxCommits]
          /\ floor \in [Keys -> -1..MaxCommits] /\ sequence \in 0..(2 * Cardinality(Keys) + MaxCommits)
NoRegression == \A k \in Keys: Effective(k) >= floor[k]
ScopeIsolation == \A k \in Keys: base[k] < 0 \/ baseScope[k] = scope
EventuallyConverged == <>[]Converged
=============================================================================
