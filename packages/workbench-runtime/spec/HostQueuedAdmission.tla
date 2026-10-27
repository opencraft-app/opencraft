---------------------- MODULE HostQueuedAdmission ----------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal
VARIABLE s
vars == <<s>>
Init == s = [captured |-> FALSE, native |-> 1, observed |-> 1,
 claim |-> 1, inputNative |-> 0, inputClaim |-> 0,
 renewed |-> FALSE, replaced |-> FALSE, workerFree |-> FALSE,
 processed |-> FALSE, crossed |-> FALSE, badCross |-> FALSE]
Capture == /\ ~s.captured
 /\ s' = [s EXCEPT !.captured = TRUE, !.inputNative = s.native, !.inputClaim = s.claim]
Renew == /\ s.captured /\ ~s.processed /\ ~s.renewed
 /\ s' = [s EXCEPT !.native = 2, !.renewed = TRUE]
ReplaceClaim == /\ s.captured /\ ~s.processed /\ ~s.replaced
 /\ s' = [s EXCEPT !.claim = 2, !.replaced = TRUE]
Observe == /\ s.renewed /\ s.observed # s.native
 /\ s' = [s EXCEPT !.observed = s.native]
FreeWorker == /\ s.captured /\ ~s.workerFree
 /\ s' = [s EXCEPT !.workerFree = TRUE]
Dequeue == /\ s.captured /\ s.workerFree /\ ~s.processed
 /\ LET nativeOK == Fault \in {"dequeue", "record-generation"}
            \/ s.inputNative = (IF Fault = "observed" THEN s.observed ELSE s.native)
        claimOK == Fault \in {"dequeue", "claim"} \/ s.inputClaim = s.claim
        valid == nativeOK /\ claimOK /\ Fault # "drop-live"
    IN s' = [s EXCEPT !.processed = TRUE, !.crossed = valid,
        !.badCross = valid /\ (s.inputNative # s.native \/ s.inputClaim # s.claim)]
Next == Capture \/ Renew \/ ReplaceClaim \/ Observe \/ FreeWorker \/ Dequeue
Spec == Init /\ [][Next]_vars /\ (IF FairLocal THEN WF_vars(Dequeue) ELSE TRUE)
TypeOK == /\ s.native \in {1, 2} /\ s.claim \in {1, 2}
 /\ s.inputNative \in {0, 1} /\ s.inputClaim \in {0, 1}
NoRetiredFrame == ~s.badCross
LiveConservation == (s.processed /\ s.inputNative = s.native /\ s.inputClaim = s.claim) => s.crossed
AdmissionProgress == (s.captured /\ s.workerFree) ~> s.processed
=============================================================================
