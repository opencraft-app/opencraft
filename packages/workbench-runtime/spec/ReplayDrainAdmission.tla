---------------------- MODULE ReplayDrainAdmission ----------------------
EXTENDS Naturals
CONSTANTS Fault, FairWork
VARIABLE s
vars == <<s>>
Init == s = [slot |-> IF Fault = "late-join" THEN 1 ELSE 0,
  oldCompletion |-> FALSE, input |-> FALSE, delivered |-> FALSE]
Admit == /\ ~s.input
 /\ s' = [s EXCEPT !.input = TRUE, !.slot = IF @ = 0 THEN 2 ELSE @]
CompleteOld == /\ ~s.oldCompletion
 /\ s' = [s EXCEPT !.oldCompletion = TRUE,
   !.slot = IF @ = 1 \/ Fault = "cleanup" THEN 0 ELSE @]
Work == /\ s.input /\ ~s.delivered /\ s.slot = 2
 /\ s' = [s EXCEPT !.delivered = TRUE, !.slot = 0]
Next == Admit \/ CompleteOld \/ Work
Spec == Init /\ [][Next]_vars /\ (IF FairWork THEN WF_vars(Work) ELSE TRUE)
TypeOK == s.slot \in 0..2
AdmissionHasWorker == (s.input /\ ~s.delivered) => s.slot = 2
CompletionOwned == (s.oldCompletion /\ s.input /\ ~s.delivered) => s.slot = 2
FrameProgress == s.input ~> s.delivered
=============================================================================
