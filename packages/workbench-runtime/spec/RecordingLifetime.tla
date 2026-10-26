------------------------ MODULE RecordingLifetime ------------------------
EXTENDS Naturals
CONSTANTS Fault, FairLocal
VARIABLE s
vars == <<s>>
Init == \E reconnect \in BOOLEAN, failedACK \in BOOLEAN:
 s = [reconnect |-> reconnect, failedACK |-> failedACK,
  closeAsked |-> FALSE, acked |-> FALSE, terminalHandled |-> FALSE,
  statusRegistered |-> TRUE, oldPending |-> TRUE,
  tap |-> "old", oldTapLive |-> TRUE, newTapLive |-> FALSE,
  successorAsked |-> FALSE, successorOpen |-> FALSE,
  samplePublications |-> 1, oldFrameHandled |-> FALSE, staleDelivered |-> FALSE,
  frameAsked |-> FALSE, frameStage |-> 0, recorded |-> FALSE, delivered |-> FALSE]
Close == /\ ~s.closeAsked
 /\ s' = [s EXCEPT !.closeAsked = TRUE, !.tap = "none",
    !.statusRegistered = IF Fault = "detach-status" THEN FALSE ELSE @]
HandleTerminal == /\ s.closeAsked /\ ~s.terminalHandled
 /\ s' = [s EXCEPT !.terminalHandled = TRUE,
    !.oldPending = IF s.statusRegistered THEN FALSE ELSE @]
Reconnect == /\ s.closeAsked /\ s.reconnect /\ ~s.successorAsked
 /\ s' = [s EXCEPT !.successorAsked = TRUE, !.tap = "new", !.newTapLive = TRUE,
    !.samplePublications = IF Fault = "broadcast-sample" THEN @ + 1 ELSE @]
OpenSuccessor == /\ s.successorAsked /\ ~s.successorOpen /\ s.tap = "new"
 /\ s.terminalHandled
 /\ s' = [s EXCEPT !.successorOpen = TRUE]
AckOld == /\ s.closeAsked /\ ~s.acked
 /\ s' = [s EXCEPT !.acked = TRUE,
    !.oldTapLive = IF Fault = "failed-cleanup" /\ s.failedACK THEN @ ELSE FALSE,
    !.tap = IF Fault = "retarget-cleanup" THEN "none" ELSE @,
    !.newTapLive = IF Fault = "retarget-cleanup" THEN FALSE ELSE @]
FinishCapturedOldFrame == /\ s.closeAsked /\ ~s.oldFrameHandled
 /\ s' = [s EXCEPT !.oldFrameHandled = TRUE,
    !.staleDelivered = Fault = "stale-frame"]
AskFrame == /\ s.successorOpen /\ ~s.frameAsked
 /\ s' = [s EXCEPT !.frameAsked = TRUE, !.frameStage = 1]
RecordFrame == /\ s.frameStage = 1 /\ s.tap = "new" /\ s.newTapLive
 /\ s' = [s EXCEPT !.recorded = TRUE,
    !.frameStage = IF Fault = "sink-stop" THEN 4 ELSE 2]
ObserveFrame == /\ s.frameStage = 2
 /\ s' = [s EXCEPT !.frameStage = IF Fault = "observer-stop" THEN 4 ELSE 3]
DeliverFrame == /\ s.frameStage = 3 /\ s.tap = "new" /\ s.newTapLive
 /\ s' = [s EXCEPT !.delivered = TRUE, !.frameStage = 5]
Next == Close \/ HandleTerminal \/ Reconnect \/ OpenSuccessor \/ AckOld
 \/ FinishCapturedOldFrame \/ AskFrame \/ RecordFrame \/ ObserveFrame \/ DeliverFrame
LocalWork == /\ WF_vars(HandleTerminal) /\ WF_vars(Reconnect) /\ WF_vars(OpenSuccessor)
 /\ WF_vars(FinishCapturedOldFrame) /\ WF_vars(RecordFrame)
 /\ WF_vars(ObserveFrame) /\ WF_vars(DeliverFrame)
Spec == Init /\ [][Next]_vars /\ (IF FairLocal THEN LocalWork ELSE TRUE)
TypeOK == /\ s.tap \in {"old", "none", "new"}
 /\ s.samplePublications \in 1..2 /\ s.frameStage \in 0..5
TerminalConserved == s.terminalHandled => ~s.oldPending
SuccessorTap == s.successorOpen => (s.tap = "new" /\ s.newTapLive)
CleanupOwned == s.acked => ~s.oldTapLive
NoFakePublication == s.samplePublications = 1
NoStaleFrame == ~s.staleDelivered
RecordedBeforeDelivery == s.delivered => s.recorded
SuccessorProgress == (s.closeAsked /\ s.reconnect) ~> s.successorOpen
FrameProgress == s.frameAsked ~> s.delivered
=============================================================================
