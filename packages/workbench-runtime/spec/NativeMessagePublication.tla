-------------------- MODULE NativeMessagePublication --------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal
VARIABLE s
vars == <<s>>
Init == s = [owner |-> 1, observedOwner |-> 1, native |-> "open", stage |-> "decoding",
 decoded |-> FALSE, peerToken |-> 1, cutToken |-> 0, observerThrew |-> FALSE,
 admittedStale |-> FALSE, deliveredStale |-> FALSE, deliveredUnadmitted |-> FALSE,
 observerFailedNative |-> FALSE, oldDecodeFailedSuccessor |-> FALSE]
Current == s.owner = 1 /\ s.native = "open"
CallbackCurrent == IF Fault = "observed-epoch" THEN s.observedOwner = 1 /\ s.native = "open" ELSE Current
ObserveStatus == /\ s.observedOwner # s.owner
 /\ s' = [s EXCEPT !.observedOwner = s.owner]
DecodeOK == /\ s.stage = "decoding"
 /\ LET admit == Current \/ Fault = "publication"
    IN s' = [s EXCEPT !.decoded = TRUE, !.stage = IF admit THEN "first" ELSE "done",
       !.cutToken = s.peerToken, !.admittedStale = admit /\ ~Current]
DecodeBad == /\ s.stage = "decoding"
 /\ LET failCurrent == Current \/ Fault = "decode-failure"
    IN s' = [s EXCEPT !.decoded = TRUE, !.stage = "done",
       !.native = IF failCurrent THEN "failed" ELSE @,
       !.oldDecodeFailedSuccessor = failCurrent /\ s.owner # 1]
ReplaceNative == /\ s.owner = 1
 /\ s' = [s EXCEPT !.owner = 2, !.native = "open"]
ReplacePeer == /\ s.peerToken = 1 /\ s.stage # "done"
 /\ s' = [s EXCEPT !.peerToken = 2]
First == /\ s.stage = "first"
 /\ s' = [s EXCEPT !.stage = IF CallbackCurrent \/ Fault = "callback" THEN "peer" ELSE "done"]
ThrowFirst == /\ s.stage = "first" /\ Current
 /\ s' = [s EXCEPT !.observerThrew = TRUE,
      !.stage = IF Fault = "exception" THEN "done" ELSE "peer",
      !.native = IF Fault = "exception" THEN "failed" ELSE @,
      !.observerFailedNative = Fault = "exception"]
Peer == /\ s.stage = "peer"
 /\ LET deliver == (CallbackCurrent \/ Fault = "callback")
                   /\ (s.peerToken = s.cutToken \/ Fault = "live-cut")
    IN s' = [s EXCEPT !.stage = "done",
       !.deliveredStale = deliver /\ ~Current,
       !.deliveredUnadmitted = deliver /\ s.peerToken # s.cutToken]
Next == ObserveStatus \/ DecodeOK \/ DecodeBad \/ ReplaceNative \/ ReplacePeer \/ First \/ ThrowFirst \/ Peer
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(First \/ ThrowFirst) /\ WF_vars(Peer) ELSE TRUE)
TypeOK == /\ s.owner \in 1..2 /\ s.peerToken \in 1..2 /\ s.cutToken \in 0..2
 /\ s.stage \in {"decoding", "first", "peer", "done"}
 /\ s.native \in {"open", "failed"}
AdmissionOwned == ~s.admittedStale
CurrentFrameOwner == ~s.deliveredStale
AdmittedOnly == ~s.deliveredUnadmitted
ObserverNotNativeFailure == ~s.observerFailedNative
DecodeFailureOwned == ~s.oldDecodeFailedSuccessor
DecodedProgress == s.decoded ~> (s.stage = "done")
=============================================================================
