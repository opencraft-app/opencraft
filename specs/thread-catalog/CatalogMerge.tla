--------------------------- MODULE CatalogMerge ---------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANT Legacy
VARIABLES phase, target, operation, view
vars == <<phase, target, operation, view>>
Ids == {"A", "B"}
Row(id, n, p, s, t) == [id |-> id, name |-> n, pinned |-> p, status |-> s, clock |-> t]
First == [id \in Ids |-> Row(id, "new", TRUE, "active", 2)]
Tail == Row("A", "old", FALSE, "idle", 1)
Base == IF Legacy THEN [First EXCEPT !["A"] = Tail] ELSE First
Init == /\ phase = "idle" /\ target = "none" /\ operation = "none" /\ view = First
Receive == /\ phase = "idle"
           /\ target' \in Ids /\ operation' \in {"rename", "status", "remove"}
           /\ phase' = "received" /\ UNCHANGED view
Apply(rows) == CASE operation = "rename" -> [rows EXCEPT ![target].name = "renamed"]
                [] operation = "status" -> [rows EXCEPT ![target].status = "review"]
                [] OTHER -> [id \in DOMAIN rows \ {target} |-> rows[id]]
Materialize == /\ phase = "received" /\ phase' = "done" /\ view' = Apply(Base)
               /\ UNCHANGED <<target, operation>>
Next == Receive \/ Materialize
Spec == Init /\ [][Next]_vars
TypeOK == phase \in {"idle", "received", "done"} /\ DOMAIN view \subseteq Ids
UntouchedRows == \A id \in Ids \ {target}: id \in DOMAIN view /\ view[id] = First[id]
PatchOwnership == phase # "done" \/
  IF operation = "rename" THEN view[target].pinned = First[target].pinned /\ view[target].status = First[target].status /\ view[target].clock = First[target].clock
  ELSE IF operation = "status" THEN view[target].pinned = First[target].pinned /\ view[target].name = First[target].name /\ view[target].clock = First[target].clock
  ELSE TRUE
=============================================================================
