--------------------- MODULE HostCleanupAdmission ---------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal, FairCurrent
VARIABLE s
vars == <<s>>
Init == s = [reset |-> FALSE, resetDone |-> FALSE, closed |-> FALSE,
 oldReserved |-> TRUE, oldDecided |-> FALSE, currentIntent |-> FALSE,
 currentReserved |-> FALSE, started |-> FALSE, currentReady |-> FALSE,
 oldCallback |-> FALSE, currentLost |-> FALSE, badOldAdmission |-> FALSE]
BeginReset == /\ ~s.reset /\ ~s.closed
 /\ s' = [s EXCEPT !.reset = TRUE, !.oldReserved = FALSE]
PhysicalRelease == /\ s.reset /\ ~s.closed
 /\ s' = [s EXCEPT !.closed = TRUE]
CompleteReset == /\ s.reset /\ ~s.resetDone
 /\ (s.closed \/ Fault = "barrier")
 /\ s' = [s EXCEPT !.resetDone = TRUE]
FreshIntent == /\ s.reset /\ ~s.currentIntent
 /\ s' = [s EXCEPT !.currentIntent = TRUE]
ReserveFresh == /\ s.currentIntent /\ s.resetDone /\ ~s.currentReserved
 /\ s' = [s EXCEPT !.currentReserved = TRUE]
WakeOld == /\ s.closed /\ ~s.oldDecided /\ Fault # "old-wait"
 /\ s' = [s EXCEPT !.oldDecided = TRUE,
   !.badOldAdmission = Fault = "revoked-admission"]
WakeFresh == /\ s.currentReserved /\ ~s.started
 /\ s' = [s EXCEPT !.started = TRUE]
OldCompletion == /\ s.oldDecided /\ s.started /\ ~s.oldCallback
 /\ s' = [s EXCEPT !.oldCallback = TRUE,
   !.currentLost = Fault = "retarget"]
CurrentReady == /\ s.started /\ ~s.currentReady /\ ~s.currentLost
 /\ s' = [s EXCEPT !.currentReady = TRUE]
Next == BeginReset \/ PhysicalRelease \/ CompleteReset \/ FreshIntent
 \/ ReserveFresh \/ WakeOld \/ WakeFresh \/ OldCompletion \/ CurrentReady
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(PhysicalRelease) /\ WF_vars(CompleteReset)
      /\ WF_vars(ReserveFresh) /\ WF_vars(WakeOld) /\ WF_vars(WakeFresh) ELSE TRUE)
 /\ (IF FairCurrent THEN WF_vars(CurrentReady) ELSE TRUE)
NoRevokedAdmission == ~s.badOldAdmission
PhysicalBarrier == s.started => s.closed
CurrentOwned == ~s.currentLost
OldWaitProgress == s.closed ~> s.oldDecided
FreshIntentProgress == (s.currentIntent /\ s.resetDone) ~> s.currentReady
=============================================================================
