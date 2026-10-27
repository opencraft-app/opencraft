------------------ MODULE HostLogicalRetirement ------------------
EXTENDS Naturals
CONSTANTS ServerOwned, Peer, Fault, FairLocal, FairClock, FairPhysical
VARIABLE s
vars == <<s>>
Init == s = [released |-> FALSE, notice |-> "active", published |-> TRUE,
 attempts |-> 0, knownRetry |-> FALSE, native |-> "pending", consumed |-> FALSE,
 connectionClosed |-> FALSE, registered |-> TRUE, physical |-> "open",
 resource |-> TRUE, physicalOwner |-> TRUE, local |-> "pending",
 uncertain |-> FALSE, fenced |-> FALSE, canReply |-> FALSE,
 newer |-> FALSE, logicalOwner |-> 1, oldContinuation |-> FALSE, badAdmission |-> FALSE]
Release == /\ ~s.released
 /\ s' = [s EXCEPT !.released = TRUE, !.notice = "pending", !.attempts = 1,
   !.published = Fault # "late-owner"]
StartCleanup == /\ s.released /\ s.physical = "open"
 /\ (~ServerOwned \/ Fault = "close-server") /\ (~Peer \/ Fault = "close-peer")
 /\ (Fault # "wait-notice" \/ s.notice # "pending")
 /\ s' = [s EXCEPT !.physical = "closing"]
PhysicalSuccess == /\ s.physical = "closing"
 /\ s' = [s EXCEPT !.physical = "closed", !.resource = FALSE, !.physicalOwner = FALSE,
   !.notice = IF @ = "pending" THEN "retired" ELSE @,
   !.registered = FALSE, !.uncertain = FALSE, !.fenced = FALSE]
PhysicalFailure == /\ s.physical = "closing"
 /\ s' = [s EXCEPT !.physical = "failed",
   !.notice = IF @ = "pending" THEN "unknown" ELSE @,
   !.registered = FALSE, !.uncertain = TRUE, !.fenced = TRUE]
PhysicalFinish == PhysicalSuccess \/ PhysicalFailure
Deadline == /\ s.notice = "pending"
 /\ s' = [s EXCEPT !.notice = "unknown", !.uncertain = TRUE, !.fenced = TRUE,
   !.physicalOwner = IF Fault = "timeout-release" THEN FALSE ELSE @]
Repair == /\ ~s.canReply /\ s' = [s EXCEPT !.canReply = TRUE]
NativeReply(result) == /\ s.released /\ s.canReply /\ s.native = "pending"
 /\ s' = [s EXCEPT !.native = result]
FinishNative == /\ s.native \in {"success", "failure"} /\ ~s.consumed
 /\ s' = [s EXCEPT !.consumed = TRUE,
   !.notice = IF @ = "pending" THEN s.native ELSE @,
   !.uncertain = s.native = "failure" /\ s.physical # "closed",
   !.fenced = s.native = "failure" /\ s.physical # "closed",
   !.registered = IF s.native = "success" \/ s.physical = "closed" THEN FALSE ELSE @]
ConnectionClose == /\ s.released /\ ~s.connectionClosed
 /\ s' = [s EXCEPT !.connectionClosed = TRUE,
   !.attempts = IF (~s.knownRetry /\ s.consumed /\ s.native = "failure")
     \/ (Fault = "duplicate-unknown" /\ s.native = "pending") THEN 2 ELSE @,
   !.knownRetry = s.consumed /\ s.native = "failure"]
LocalSettle == /\ s.released /\ s.local = "pending" /\ s.notice # "pending"
 /\ (ServerOwned \/ Peer \/ s.physical \in {"closed", "failed"})
 /\ s' = [s EXCEPT !.local = IF s.physical = "failed" \/ s.notice \in {"failure", "unknown"}
   THEN "rejected" ELSE "resolved"]
FreshRegistration == /\ s.local # "pending" /\ ~s.newer
 /\ s.physical = "open" /\ (~s.fenced \/ Fault = "admit-failed")
 /\ s' = [s EXCEPT !.newer = TRUE, !.logicalOwner = 2, !.badAdmission = s.uncertain]
OldContinuation == /\ s.newer /\ s.consumed /\ ~s.oldContinuation
 /\ s' = [s EXCEPT !.oldContinuation = TRUE,
   !.logicalOwner = IF Fault = "retarget" THEN 0 ELSE @]
Next == Release \/ StartCleanup \/ PhysicalFinish \/ Deadline \/ Repair
 \/ NativeReply("success") \/ NativeReply("failure") \/ FinishNative
 \/ ConnectionClose \/ LocalSettle \/ FreshRegistration \/ OldContinuation
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(StartCleanup) /\ WF_vars(LocalSettle) /\ WF_vars(FinishNative) ELSE TRUE)
 /\ (IF FairClock THEN WF_vars(Deadline) ELSE TRUE)
 /\ (IF FairPhysical THEN WF_vars(PhysicalFinish) ELSE TRUE)
TypeOK == /\ s.attempts \in 0..2 /\ s.logicalOwner \in 0..2
 /\ s.physical \in {"open", "closing", "closed", "failed"}
 /\ s.notice \in {"active", "pending", "success", "failure", "unknown", "retired"}
OwnerBeforeProvider == s.attempts > 0 => s.published
PhysicalConserved == s.resource => s.physicalOwner
PeerAlive == Peer => s.physical = "open"
ServiceAlive == ServerOwned => s.physical = "open"
UnknownOnce == s.attempts <= 1 \/ s.knownRetry
AdmissionSafe == ~s.badAdmission
CurrentRegistration == s.newer => s.logicalOwner = 2
ReleaseProgress == (~ServerOwned /\ ~Peer /\ s.released) ~> (s.physical # "open")
CallerProgress == s.released ~> (s.local # "pending")
===================================================================
