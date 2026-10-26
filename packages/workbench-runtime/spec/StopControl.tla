-------------------------- MODULE StopControl --------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLE s
vars == <<s>>
Init == s = [stage |-> "reserved", slot |-> Fault # "slot", epoch |-> 0,
  captured |-> 0, ready |-> TRUE, owner |-> TRUE, allowed |-> TRUE,
  history |-> FALSE, prompt |-> FALSE, head |-> 0, sends |-> 0,
  reentered |-> FALSE, badAdmission |-> FALSE, badTarget |-> FALSE]
Current == s.ready /\ s.owner /\ s.allowed /\ s.captured = s.epoch
Prepare == /\ s.stage = "reserved" /\ s.ready /\ s.owner /\ s.allowed
  /\ s' = [s EXCEPT !.stage = "prepared", !.captured = s.epoch]
Dispatch == /\ s.stage = "prepared"
  /\ (Current \/ Fault = "fence")
  /\ (Fault # "history" \/ s.history) /\ (Fault # "prompt" \/ s.prompt)
  /\ s' = [s EXCEPT !.stage = "sent", !.sends = @ + 1,
    !.badAdmission = @ \/ ~Current,
    !.badTarget = @ \/ (Fault = "target" /\ s.head # 0)]
\* Current local ownership can end without a history reply or a remote ACK.
Reject == /\ s.stage \in {"reserved", "prepared"}
  /\ (~s.owner \/ ~s.allowed \/ (s.stage = "prepared" /\ ~Current))
  /\ s' = [s EXCEPT !.stage = "done"]
Complete == /\ s.stage = "sent" /\ s' = [s EXCEPT !.stage = "done"]
HistoryReply == /\ ~s.history /\ s' = [s EXCEPT !.history = TRUE]
PromptReply == /\ ~s.prompt /\ s' = [s EXCEPT !.prompt = TRUE]
AdvanceHead == /\ s.head = 0 /\ s' = [s EXCEPT !.head = 1]
ChangeConnection == /\ s.epoch = 0 /\ s' = [s EXCEPT !.epoch = 1, !.ready = FALSE]
ReturnHost == /\ ~s.ready /\ s' = [s EXCEPT !.ready = TRUE]
Dispose == /\ s.owner /\ s' = [s EXCEPT !.owner = FALSE]
Revoke == /\ s.allowed /\ s' = [s EXCEPT !.allowed = FALSE]
\* An observer reenters the same intent before first transport admission.
\* A reserved slot makes it join. The mutant admits a second local send.
Reenter == /\ ~s.reentered /\ s.stage = "prepared" /\ Current
  /\ s' = [s EXCEPT !.reentered = TRUE,
    !.sends = IF s.slot THEN @ ELSE @ + 1]
Replay == /\ Fault = "replay" /\ s.stage = "done" /\ s.sends = 1
  /\ s' = [s EXCEPT !.sends = 2]
Next == Prepare \/ Dispatch \/ Reject \/ Complete \/ HistoryReply \/ PromptReply
  \/ AdvanceHead \/ ChangeConnection \/ ReturnHost \/ Dispose \/ Revoke \/ Reenter \/ Replay
SafetySpec == Init /\ [][Next]_vars
\* Neither historical I/O nor prompt receipt has fairness. Physical churn is
\* finite in this abstraction; a real permanently unavailable Host cannot progress.
FairSpec == SafetySpec /\ WF_vars(Prepare) /\ WF_vars(Dispatch)
  /\ WF_vars(Reject) /\ WF_vars(Complete) /\ WF_vars(ReturnHost)
TypeOK == /\ s.stage \in {"reserved", "prepared", "sent", "done"}
  /\ s.epoch \in 0..1 /\ s.captured \in 0..1 /\ s.head \in 0..1 /\ s.sends \in 0..2
  /\ s.slot \in BOOLEAN /\ s.ready \in BOOLEAN /\ s.owner \in BOOLEAN /\ s.allowed \in BOOLEAN
  /\ s.history \in BOOLEAN /\ s.prompt \in BOOLEAN /\ s.reentered \in BOOLEAN
  /\ s.badAdmission \in BOOLEAN /\ s.badTarget \in BOOLEAN
StopAdmission == ~s.badAdmission
ExactTarget == ~s.badTarget
NoDuplicateStop == s.sends <= 1
StopProgress == <>(s.stage = "done")
=============================================================================
