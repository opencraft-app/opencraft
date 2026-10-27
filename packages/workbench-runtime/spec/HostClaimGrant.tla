------------------------ MODULE HostClaimGrant ------------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal, FairServer
VARIABLE s
vars == <<s>>
Init == s = [known |-> FALSE, retired |-> FALSE, delivered |-> FALSE,
 wanted |-> FALSE, posted |-> FALSE, count |-> 0, removed |-> FALSE,
 peerRemoved |-> FALSE, continuation |-> FALSE, duplicateAck |-> FALSE,
 sharedOpen |-> FALSE]
Retire == /\ ~s.retired
 /\ s' = [s EXCEPT !.retired = TRUE,
   !.wanted = Fault # "forget-unknown" \/ s.known]
ReceiveOwnGrant == /\ ~s.delivered
 /\ s' = [s EXCEPT !.delivered = TRUE,
   !.known = Fault # "discard-before-grant" \/ ~s.retired]
SharedOpen == /\ ~s.sharedOpen
 /\ s' = [s EXCEPT !.sharedOpen = TRUE,
   !.known = @ \/ Fault = "shared-grant"]
OldContinuation == /\ s.delivered /\ ~s.continuation
 /\ s' = [s EXCEPT !.continuation = TRUE]
DuplicateGrant == /\ s.delivered /\ ~s.duplicateAck
 /\ s' = [s EXCEPT !.duplicateAck = TRUE]
PostRelease == /\ s.wanted /\ (s.known \/ Fault = "before-grant")
 /\ (~s.posted \/ (Fault = "duplicate-release" /\ s.count < 2))
 /\ (Fault # "wait-continuation" \/ s.continuation)
 /\ s' = [s EXCEPT !.posted = TRUE,
   !.count = @ + (IF Fault = "reentrant-release" THEN 2 ELSE 1)]
ServerRelease == /\ s.posted /\ ~s.removed
 /\ s' = [s EXCEPT !.removed = TRUE,
   !.peerRemoved = Fault = "generation-only"]
Next == Retire \/ ReceiveOwnGrant \/ SharedOpen \/ OldContinuation
 \/ DuplicateGrant \/ PostRelease \/ ServerRelease
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(PostRelease) ELSE TRUE)
 /\ (IF FairServer THEN WF_vars(ServerRelease) ELSE TRUE)
TypeOK == s.count \in 0..2
ReleaseAuthorized == s.posted => (s.retired /\ s.delivered)
ExactlyOneRelease == s.count <= 1
PeerProtected == ~s.peerRemoved
ReclaimAfterGrant == (s.retired /\ s.delivered) ~> s.removed
UnconditionalReclaim == s.retired ~> s.removed
=============================================================================
