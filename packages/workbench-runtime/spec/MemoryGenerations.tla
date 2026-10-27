------------------------- MODULE MemoryGenerations -------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS GuardAdmission, GuardPeerClose, GuardPeerSend, GuardQueue, GuardAck,
          ImmediateCancel, GuardCleanup, OnceCleanup, FairCleanup, FairLive
G == 1..2
VARIABLE s
vars == <<s>>
Init == s = [current |-> 0, writer |-> 0, status |-> "idle",
  started |-> [g \in G |-> FALSE], done |-> [g \in G |-> FALSE],
  retired |-> [g \in G |-> FALSE], connect |-> [g \in G |-> "absent"],
  close |-> [g \in G |-> "absent"], cleanup |-> [g \in G |-> 0],
  acked |-> [g \in G |-> FALSE], sent |-> [g \in G |-> FALSE],
  peerClosed |-> [g \in G |-> FALSE], queue |-> [g \in G |-> 0], badFrame |-> FALSE]
Revoke(x, g) == [x EXCEPT !.retired[g] = TRUE,
  !.connect[g] = IF ImmediateCancel /\ x.connect[g] = "pending" THEN "rejected" ELSE @]
Begin(g) == /\ ~s.started[g]
  /\ ((g = 1 /\ s.current = 0) \/ (g = 2 /\ s.current = 1 /\ s.retired[1]))
  /\ s' = [s EXCEPT !.current = g, !.writer = g, !.status = "connecting",
             !.started[g] = TRUE, !.connect[g] = "pending"]
Complete(g) == /\ s.started[g] /\ ~s.done[g]
  /\ \E ok \in BOOLEAN:
    LET active == s.current = g /\ ~s.retired[g]
        base == [s EXCEPT !.done[g] = TRUE]
        result == IF ok THEN "resolved" ELSE "rejected"
    IN s' = IF active \/ ~GuardAdmission
      THEN [base EXCEPT !.connect[g] = IF @ = "pending" THEN result ELSE @,
            !.status = IF ok THEN "open" ELSE "failed", !.writer = g,
            !.retired[g] = IF ~ok THEN TRUE ELSE @]
      ELSE base
LocalClose(g) == /\ s.current = g /\ ~s.retired[g]
  /\ LET base == Revoke(s, g)
         wait == s.connect[g] = "resolved"
     IN s' = [base EXCEPT !.status = IF wait THEN "closing" ELSE "closed",
               !.writer = g, !.close[g] = IF wait THEN "pending" ELSE "resolved"]
Abort(g) == /\ s.current = g /\ ~s.retired[g] /\ s.connect[g] = "pending"
  /\ s' = [Revoke(s, g) EXCEPT !.status = "closed", !.writer = g]
PeerClose(g) == /\ s.started[g] /\ ~s.peerClosed[g]
  /\ LET allowed == s.current = g /\ ~s.retired[g]
         target == IF allowed THEN g ELSE s.current
         effective == allowed \/ (~GuardPeerClose /\ s.status = "open")
         base == IF effective THEN Revoke(s, target) ELSE s
     IN s' = [base EXCEPT !.peerClosed[g] = TRUE,
               !.status = IF effective THEN "closed" ELSE @,
               !.writer = IF effective THEN g ELSE @]
Send(g) == /\ s.started[g] /\ ~s.sent[g]
  /\ LET allowed == s.status = "open" /\ ((s.current = g /\ ~s.retired[g]) \/ ~GuardPeerSend)
     IN s' = [s EXCEPT !.sent[g] = TRUE,
               !.queue[g] = IF allowed THEN (IF GuardPeerSend THEN g ELSE s.current) ELSE 0]
Deliver(g) == /\ s.queue[g] # 0
  /\ LET allowed == s.status = "open" /\ ((s.queue[g] = s.current /\ ~s.retired[s.current]) \/ ~GuardQueue)
     IN s' = [s EXCEPT !.queue[g] = 0,
               !.badFrame = @ \/ (allowed /\ g # s.current)]
Cleanup(g) == /\ s.started[g] /\ s.retired[g]
  /\ (s.done[g] \/ ~GuardCleanup)
  /\ s.cleanup[g] < (IF OnceCleanup THEN 1 ELSE 2)
  /\ s' = [s EXCEPT !.cleanup[g] = @ + 1]
Ack(g) == /\ s.cleanup[g] > 0 /\ ~s.acked[g]
  /\ LET writes == s.close[g] = "pending" /\ (s.current = g \/ ~GuardAck)
     IN s' = [s EXCEPT !.acked[g] = TRUE,
               !.close[g] = IF @ = "pending" THEN "resolved" ELSE @,
               !.status = IF writes THEN "closed" ELSE @,
               !.writer = IF writes THEN g ELSE @]
Next == \E g \in G: Begin(g) \/ Complete(g) \/ LocalClose(g) \/ Abort(g) \/ PeerClose(g) \/ Send(g) \/ Deliver(g) \/ Cleanup(g) \/ Ack(g)
Spec == Init /\ [][Next]_vars
  /\ (IF FairLive THEN (\A g \in G: WF_vars(Complete(g) /\ ~s.retired[g])) ELSE TRUE)
  /\ (IF FairCleanup THEN (\A g \in G: WF_vars(Cleanup(g))) ELSE TRUE)
  /\ \A g \in G: WF_vars(Ack(g))
CurrentStatus == s.current = 0 \/ (s.writer = s.current /\
  (s.status = "open" => ~s.retired[s.current] /\ s.connect[s.current] = "resolved"))
FrameOwner == ~s.badFrame
CleanupAfterAdmission == \A g \in G: s.cleanup[g] > 0 => s.done[g] /\ s.retired[g]
CleanupAtMostOnce == \A g \in G: s.cleanup[g] <= 1
LocalCompletion == \A g \in G: s.retired[g] ~> (s.connect[g] # "pending")
CurrentCompletion == \A g \in G: (s.current = g /\ ~s.retired[g] /\ s.connect[g] = "pending") ~> (s.connect[g] # "pending")
CleanupProgress == \A g \in G: (s.retired[g] /\ s.done[g]) ~> (s.cleanup[g] = 1)
CloseCompletion == \A g \in G: (s.close[g] = "pending") ~> (s.close[g] = "resolved")
=============================================================================
