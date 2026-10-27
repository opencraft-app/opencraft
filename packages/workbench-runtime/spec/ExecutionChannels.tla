---------------------- MODULE ExecutionChannels ----------------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLE s
vars == <<s>>
Init == s = [read |-> "held", native |-> 1, handled |-> {}, answered |-> {},
  retired |-> {}, reused |-> FALSE, late |-> FALSE, oldCleanup |-> FALSE,
  settings |-> FALSE, model |-> 0, badHandler |-> FALSE, lost |-> FALSE]
ReadCancel == /\ s.read = "held"
  /\ s' = [s EXCEPT !.read = "cancelled",
    !.lost = @ \/ (Fault = "cancel" /\ s.native # 0),
    !.native = IF Fault = "cancel" THEN 0 ELSE @]
ReadReply == /\ s.read = "held"
  /\ s' = [s EXCEPT !.read = "done", !.model = IF Fault = "ack" THEN 0 ELSE @]
LiveSettings == /\ ~s.settings
  /\ s' = [s EXCEPT !.settings = TRUE,
    !.model = IF Fault = "settings" /\ s.read = "held" THEN 0 ELSE 1]
NativeHandle == /\ s.native # 0 /\ s.native \notin s.handled
  /\ (Fault # "gate" \/ s.read = "done")
  /\ s' = [s EXCEPT !.handled = @ \cup {s.native}]
NativeAnswer == /\ s.native # 0 /\ s.native \in s.handled
  /\ s' = [s EXCEPT !.answered = @ \cup {s.native}, !.native = 0]
\* The wire id is reused by a distinct native context. Old cleanup must not
\* remove it; no Read completion or fairness is required for its own progress.
ResolveAndReuse == /\ s.native = 1 /\ ~s.reused
  /\ s' = [s EXCEPT !.native = 2, !.retired = {1}, !.reused = TRUE]
LateHandler == /\ 1 \in s.retired /\ ~s.late
  /\ s' = [s EXCEPT !.late = TRUE, !.badHandler = Fault = "handler"]
OldCleanup == /\ s.reused /\ ~s.oldCleanup
  /\ s' = [s EXCEPT !.oldCleanup = TRUE,
    !.native = IF Fault = "cleanup" /\ s.native = 2 THEN 0 ELSE @,
    !.lost = @ \/ (Fault = "cleanup" /\ s.native = 2)]
Next == ReadCancel \/ ReadReply \/ LiveSettings \/ NativeHandle \/ NativeAnswer \/ ResolveAndReuse \/ LateHandler \/ OldCleanup
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(NativeHandle) /\ WF_vars(NativeAnswer)
TypeOK == /\ s.read \in {"held", "done", "cancelled"} /\ s.native \in 0..2
  /\ s.handled \subseteq {1,2} /\ s.answered \subseteq {1,2} /\ s.retired \subseteq {1}
  /\ s.reused \in BOOLEAN /\ s.late \in BOOLEAN /\ s.oldCleanup \in BOOLEAN
  /\ s.settings \in BOOLEAN /\ s.model \in 0..1 /\ s.badHandler \in BOOLEAN /\ s.lost \in BOOLEAN
LiveMetadata == s.settings => s.model = 1
NativeConserved == ~s.lost
RetiredHandler == ~s.badHandler
SuccessorOwner == s.reused => s.native = 2 \/ 2 \in s.answered
NativeProgress == <>(s.answered # {})
=============================================================================
