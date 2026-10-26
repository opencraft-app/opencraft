---------------------- MODULE HostTerminalPublication ----------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal
VARIABLE s
vars == <<s>>
Init == s = [closed |-> FALSE, phase |-> "idle", late |-> FALSE,
 cutLate |-> FALSE, deliveredB |-> FALSE, deliveredLate |-> FALSE,
 interrupted |-> FALSE, cleared |-> FALSE]
Begin == /\ ~s.closed
 /\ s' = [s EXCEPT !.closed = TRUE, !.phase = "a", !.cutLate = s.late]
LateSubscribe == /\ s.phase = "a" /\ ~s.late
 /\ s' = [s EXCEPT !.late = TRUE]
NotifyA == /\ s.phase = "a"
 /\ s' = [s EXCEPT !.phase = "b",
      !.cutLate = IF Fault = "late-cut" THEN s.late ELSE @]
ThrowA == /\ s.phase = "a"
 /\ s' = [s EXCEPT !.phase = IF Fault = "exception" THEN "done" ELSE "b",
      !.interrupted = Fault = "exception",
      !.cutLate = IF Fault = "late-cut" THEN s.late ELSE @]
NotifyB == /\ s.phase = "b"
 /\ s' = [s EXCEPT !.phase = "done",
      !.deliveredB = Fault # "closed-gate",
      !.deliveredLate = s.cutLate /\ Fault # "closed-gate"]
Clear == /\ s.phase = "done" /\ ~s.cleared
 /\ s' = [s EXCEPT !.cleared = TRUE]
Next == Begin \/ LateSubscribe \/ NotifyA \/ ThrowA \/ NotifyB \/ Clear
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(NotifyA \/ ThrowA) /\ WF_vars(NotifyB) /\ WF_vars(Clear) ELSE TRUE)
TypeOK == s.phase \in {"idle", "a", "b", "done"}
ExceptionIsolated == ~s.interrupted
TerminalConserved == (s.phase = "done") => s.deliveredB
AdmittedOnly == ~s.deliveredLate
TerminalProgress == s.closed ~> (s.deliveredB /\ s.cleared)
=============================================================================
