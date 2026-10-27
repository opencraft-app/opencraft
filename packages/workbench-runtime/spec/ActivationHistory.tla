---------------------- MODULE ActivationHistory ----------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLE s
vars == <<s>>
Init == s = [epoch |-> 0, readDone |-> TRUE, history |-> 0,
  activation |-> "pending", oldHistory |-> FALSE, oldCleanup |-> FALSE,
  buffer |-> 0, requestWaiting |-> TRUE, requestDelivered |-> FALSE,
  requestLost |-> FALSE, intent |-> TRUE, sends |-> 0]
\* The old execution activation may never acknowledge. Current presentation
\* recovery must not depend on that ACK, and cannot cancel the user's intent.
Reconnect == /\ s.epoch = 0 /\ s.sends = 0
  /\ (s.activation = "pending" \/ (s.activation = "ready" /\ ~s.oldHistory))
  /\ s' = [s EXCEPT !.epoch = 1, !.readDone = FALSE, !.buffer = 1,
    !.requestLost = @ \/ (Fault = "requests" /\ s.requestWaiting),
    !.requestWaiting = IF Fault = "requests" THEN FALSE ELSE @,
    !.activation = IF Fault = "cancel" THEN "cancelled" ELSE @,
    !.intent = IF Fault = "cancel" THEN FALSE ELSE @]
ReadReply == /\ s.epoch = 1 /\ ~s.readDone
  /\ (Fault # "gate" \/ s.activation = "ready")
  /\ s' = [s EXCEPT !.readDone = TRUE, !.history = 1, !.buffer = 2,
    !.requestDelivered = @ \/ s.requestWaiting, !.requestWaiting = FALSE]
ActivationReply == /\ s.activation = "pending"
  /\ s' = [s EXCEPT !.activation = "ready"]
\* Old history/cleanup can occur before or after the current read. Execution
\* metadata is independent; it cannot reclaim presentation authority.
CurrentHistoryReply == /\ s.epoch = 0 /\ s.activation = "ready" /\ ~s.oldHistory
  /\ s' = [s EXCEPT !.oldHistory = TRUE, !.buffer = 2,
    !.requestDelivered = @ \/ s.requestWaiting, !.requestWaiting = FALSE]
RetiredHistoryReply == /\ s.epoch = 1 /\ s.activation = "ready" /\ ~s.oldHistory
  /\ s' = [s EXCEPT !.oldHistory = TRUE,
    !.history = IF Fault = "commit" THEN 0 ELSE @]
OldCleanup == /\ s.epoch = 1 /\ s.activation = "ready" /\ s.oldHistory /\ ~s.oldCleanup
  /\ s' = [s EXCEPT !.oldCleanup = TRUE,
    !.buffer = IF Fault = "buffer" /\ ~s.readDone THEN 2 ELSE @]
Dispatch == /\ s.activation = "ready" /\ s.intent /\ s.sends < 2
  /\ (s.readDone \/ Fault = "dispatch")
  /\ (s.epoch = 1 \/ s.oldHistory \/ Fault = "dispatch")
  /\ (Fault # "strategy" \/ s.oldHistory)
  /\ s' = [s EXCEPT !.sends = @ + 1, !.intent = Fault = "replay"]
Next == Reconnect \/ ReadReply \/ ActivationReply \/ CurrentHistoryReply \/ RetiredHistoryReply \/ OldCleanup \/ Dispatch
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(ReadReply) /\ WF_vars(CurrentHistoryReply)
ExecutionFairSpec == FairSpec /\ WF_vars(ActivationReply) /\ WF_vars(Dispatch)
TypeOK == /\ s.epoch \in 0..1 /\ s.history \in 0..1 /\ s.readDone \in BOOLEAN
  /\ s.activation \in {"pending", "ready", "cancelled"}
  /\ s.oldHistory \in BOOLEAN /\ s.oldCleanup \in BOOLEAN
  /\ s.buffer \in 0..2 /\ s.requestWaiting \in BOOLEAN
  /\ s.requestDelivered \in BOOLEAN /\ s.requestLost \in BOOLEAN
  /\ s.intent \in BOOLEAN /\ s.sends \in 0..2
CurrentHistory == s.epoch = 1 /\ s.readDone => s.history = 1
BufferOwner == s.epoch = 1 /\ ~s.readDone => s.buffer = 1
RequestConserved == ~s.requestLost /\ (s.requestWaiting \/ s.requestDelivered)
CommandAdmission == s.sends > 0 => s.activation = "ready" /\ s.readDone
  /\ (s.epoch = 1 \/ s.oldHistory)
NoReplay == s.sends <= 1
IntentPreserved == s.activation # "cancelled" /\ (s.sends > 0 \/ s.intent)
ReadRecovery == (s.epoch = 1) ~> s.readDone
CommandProgress == <>(s.sends = 1)
=============================================================================
