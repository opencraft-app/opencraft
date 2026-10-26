--------------------- MODULE HostPhysicalCleanup ---------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Path, Fault, FairLocal
VARIABLE s
vars == <<s>>
Init == s = [owner |-> 1, allocated |-> 1, resources |-> {1},
 phase |-> IF Path = "startup" THEN "starting" ELSE "open",
 result |-> "none", wanted |-> FALSE, retries |-> 0,
 shutdown |-> Path = "shutdown", shutdownOutcome |-> "pending",
 observedClosed |-> FALSE, oldDisposed |-> FALSE, oldCallback |-> FALSE]
RequestClose == /\ s.phase \in {"starting", "open"}
 /\ s' = [s EXCEPT !.phase = "closing", !.result = "pending", !.wanted = TRUE,
   !.owner = IF Fault = "late-owner" THEN 0 ELSE @]
ObserveClosed == /\ ~s.observedClosed
 /\ s' = [s EXCEPT !.observedClosed = TRUE]
CloseSuccess == /\ s.phase = "closing" /\ s.result = "pending"
 /\ s' = [s EXCEPT !.result = "success", !.resources = @ \ {s.owner}]
CloseFailure(released) == /\ s.phase = "closing" /\ s.result = "pending"
 /\ LET discard == (Path = "normal" /\ Fault = "discard-normal")
        \/ (Path = "startup" /\ Fault = "discard-startup")
    IN s' = [s EXCEPT !.result = "failure",
      !.resources = IF released THEN @ \ {s.owner} ELSE @,
      !.phase = IF discard THEN "idle" ELSE "quarantine",
      !.owner = IF discard THEN 0 ELSE @,
      !.shutdownOutcome = IF s.shutdown THEN
        (IF Fault = "ignore-shutdown" THEN "resolved" ELSE "rejected") ELSE @]
LocalSuccess == /\ s.phase = "closing" /\ s.result = "success"
 /\ s' = [s EXCEPT !.phase = "idle", !.owner = 0,
   !.oldDisposed = @ \/ s.allocated = 1,
   !.shutdownOutcome = IF s.shutdown THEN "resolved" ELSE @]
TrustedRetry == /\ s.phase = "quarantine" /\ s.retries = 0
 /\ s' = [s EXCEPT !.phase = "closing", !.result = "pending", !.retries = 1,
   !.shutdownOutcome = IF s.shutdown THEN "pending" ELSE @,
   !.owner = IF Fault = "retry-new" THEN 2 ELSE @,
   !.resources = IF Fault = "retry-new" THEN @ \cup {2} ELSE @,
   !.allocated = IF Fault = "retry-new" THEN 2 ELSE @]
ObserverTimeout == /\ s.phase = "closing" /\ s.result = "pending"
 /\ Fault = "timeout-release"
 /\ s' = [s EXCEPT !.phase = "idle", !.owner = 0]
AllocateNext == /\ ~s.shutdown /\ s.allocated = 1
 /\ (s.phase = "idle" \/ (Fault = "trust-label" /\ s.phase = "quarantine" /\ s.observedClosed))
 /\ s' = [s EXCEPT !.owner = 2, !.allocated = 2, !.resources = @ \cup {2},
   !.phase = "open", !.result = "none", !.wanted = FALSE, !.observedClosed = FALSE]
OldCompletion == /\ s.oldDisposed /\ s.owner = 2 /\ ~s.oldCallback
 /\ s' = [s EXCEPT !.oldCallback = TRUE,
   !.owner = IF Fault = "retarget" THEN 0 ELSE @,
   !.phase = IF Fault = "retarget" THEN "idle" ELSE @]
Next == RequestClose \/ ObserveClosed \/ CloseSuccess \/ CloseFailure(FALSE)
 \/ CloseFailure(TRUE) \/ LocalSuccess \/ TrustedRetry \/ ObserverTimeout
 \/ AllocateNext \/ OldCompletion
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(LocalSuccess) ELSE TRUE)
TypeOK == /\ s.owner \in 0..2 /\ s.allocated \in 1..2
 /\ s.resources \subseteq {1, 2} /\ s.retries \in 0..1
AtMostOnePhysical == Cardinality(s.resources) <= 1
HandleConserved == s.resources \subseteq ({s.owner} \ {0})
QuarantineOwned == s.phase = "quarantine" => s.owner # 0
ShutdownHonest == s.shutdownOutcome = "resolved" => (s.resources = {} /\ s.owner = 0)
SuccessSettles == (s.wanted /\ s.result = "success") ~> (s.owner = 0 \/ s.allocated = 2)
UnconditionalCloseProgress == s.wanted ~> (s.owner = 0 \/ s.allocated = 2)
=============================================================================
