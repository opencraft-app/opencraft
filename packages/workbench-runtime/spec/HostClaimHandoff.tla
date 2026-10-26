----------------------- MODULE HostClaimHandoff -----------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Fault, FairLocal, FairServer, Peer
VARIABLE s
vars == <<s>>
Old == 1
Fresh == IF Fault = "reuse-id" THEN 1 ELSE 2
PeerId == 3
Init == s = [claims |-> IF Peer THEN {Old, PeerId} ELSE {Old},
 retired |-> FALSE, freshPosted |-> FALSE, reserved |-> FALSE,
 grantDelivered |-> FALSE, freshLive |-> FALSE, freshClosed |-> FALSE,
 releasePosted |-> FALSE, oldRemoved |-> FALSE, oldAck |-> FALSE,
 closeStarted |-> FALSE, oldCallback |-> FALSE, successorLost |-> FALSE,
 foreignRemoved |-> FALSE, queuedBlocked |-> TRUE]
Retire == /\ ~s.retired
 /\ s' = [s EXCEPT !.retired = TRUE]
PostFresh == /\ s.retired /\ ~s.freshPosted
 /\ s' = [s EXCEPT !.freshPosted = TRUE]
ReserveFresh == /\ s.freshPosted /\ ~s.reserved /\ ~s.closeStarted
 /\ s' = [s EXCEPT !.reserved = TRUE, !.claims = @ \cup {Fresh}]
PostRelease == /\ s.retired /\ ~s.releasePosted
 /\ Fault # "forget-old"
 /\ (s.freshPosted \/ Fault = "release-first")
 /\ s' = [s EXCEPT !.releasePosted = TRUE]
RemoveOld == /\ s.releasePosted /\ ~s.oldRemoved
 /\ (s.reserved \/ Fault \in {"release-first", "unordered"})
 /\ (Fault # "queued-control" \/ ~s.queuedBlocked)
 /\ LET removed == IF Fault = "all-peers" THEN s.claims ELSE {Old}
    IN s' = [s EXCEPT !.claims = @ \ removed, !.oldRemoved = TRUE,
        !.foreignRemoved = Peer /\ PeerId \in removed]
OldAck == /\ s.oldRemoved /\ ~s.oldAck
 /\ s' = [s EXCEPT !.oldAck = TRUE]
DeliverGrant == /\ s.reserved /\ ~s.grantDelivered
 /\ (Fault # "wait-release-ack" \/ s.oldAck)
 /\ s' = [s EXCEPT !.grantDelivered = TRUE, !.freshLive = TRUE]
LateOldCallback == /\ s.oldRemoved /\ s.grantDelivered /\ ~s.oldCallback
 /\ s' = [s EXCEPT !.oldCallback = TRUE,
    !.successorLost = Fault = "retarget",
    !.claims = IF Fault = "retarget" THEN @ \ {Fresh} ELSE @]
CloseFresh == /\ s.freshLive /\ s.oldRemoved /\ ~s.freshClosed
 /\ s' = [s EXCEPT !.freshClosed = TRUE, !.freshLive = FALSE,
    !.claims = @ \ {Fresh}]
StartPhysicalClose == /\ s.claims = {} /\ ~s.closeStarted
 /\ s' = [s EXCEPT !.closeStarted = TRUE]
Next == Retire \/ PostFresh \/ ReserveFresh \/ PostRelease \/ RemoveOld
 \/ OldAck \/ DeliverGrant \/ LateOldCallback \/ CloseFresh \/ StartPhysicalClose
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(PostFresh) /\ WF_vars(PostRelease) ELSE TRUE)
 /\ (IF FairServer THEN WF_vars(ReserveFresh) /\ WF_vars(RemoveOld)
      /\ WF_vars(DeliverGrant) /\ WF_vars(StartPhysicalClose) ELSE TRUE)
TypeOK == /\ s.claims \subseteq {1, 2, 3}
 /\ s.freshClosed => s.grantDelivered
ReservationProtected == (s.reserved /\ ~s.freshClosed) => Fresh \in s.claims
PeerProtected == ~s.foreignRemoved /\ (Peer => PeerId \in s.claims)
HandoffProtected == s.closeStarted => s.freshClosed
CallbackOwned == ~s.successorLost
ObsoleteReclaimed == s.retired ~> s.oldRemoved
FreshProgress == (s.retired /\ ~s.freshClosed) ~> s.grantDelivered
LastClaimProgress == (s.freshClosed /\ ~Peer) ~> s.closeStarted
=============================================================================
