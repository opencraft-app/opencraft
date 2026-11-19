-------------------------- MODULE ChannelSend --------------------------
EXTENDS Naturals
CONSTANT Fault

(* The three scopes use the same client message ID. Payload values stand for
   distinct normalized payloads. The effect counters are checker observations,
   not information OpenCraft receives from the provider. *)
Keys == {<<"alice", "work">>, <<"bob", "work">>, <<"alice", "ops">>}
Payloads == {"text", "image"}
Terminal == {"delivered", "rejected", "unknown"}
ReceiptStates == {"none", "sending"} \cup Terminal
Blank == [payload |-> "none", status |-> "none", attribution |-> "none",
          labelIssued |-> FALSE, bodyIssued |-> FALSE,
          labelAttempts |-> 0, bodyAttempts |-> 0]
NoReply == [kind |-> "none", key |-> <<"alice", "work">>,
            row |-> <<"alice", "work">>, payload |-> "text"]

VARIABLE s
vars == <<s>>

Init == s = [rows |-> [k \in Keys |-> Blank],
             running |-> TRUE, online |-> TRUE, reply |-> NoReply]

Claim(k, payload) ==
    /\ s.online /\ s.rows[k].status = "none"
    /\ s' = [s EXCEPT !.rows[k].payload = payload, !.rows[k].status = "sending"]

(* Both a repeated send and a delivery query read an existing durable row.
   A retry may see a pending receipt, or its later terminal state. *)
Lookup(k, payload) ==
    /\ s.online /\ s.rows[k].status # "none"
    /\ LET others == {j \in Keys : j # k /\ s.rows[j].status # "none"}
           row == IF Fault = "cross-scope-reply" /\ others # {}
                  THEN CHOOSE j \in others : TRUE ELSE k
           kind == IF s.rows[row].payload = payload THEN "replay" ELSE "conflict"
       IN s' = [s EXCEPT !.reply = [kind |-> kind, key |-> k, row |-> row, payload |-> payload],
               !.rows[k].status = IF Fault = "retry-unknown" /\ @ = "unknown" /\ kind = "replay"
                                  THEN "sending" ELSE @]

LabelIssue(k) ==
    /\ s.running /\ s.rows[k].status = "sending" /\ s.rows[k].payload = "image"
    /\ s.rows[k].attribution = "none" /\ ~s.rows[k].labelIssued
    /\ s.rows[k].labelAttempts < 2
    /\ s' = [s EXCEPT !.rows[k].attribution = "sending",
              !.rows[k].labelIssued = TRUE, !.rows[k].labelAttempts = @ + 1]

LabelResult(k, result) ==
    /\ s.running /\ s.rows[k].status = "sending" /\ s.rows[k].labelIssued
    /\ s.rows[k].attribution = "sending"
    /\ s' = [s EXCEPT !.rows[k].attribution = result]

LabelFailed(k) ==
    /\ s.running /\ s.rows[k].status = "sending"
    /\ s.rows[k].attribution \in {"rejected", "unknown"}
    /\ s' = [s EXCEPT !.rows[k].status = "rejected"]

BodyIssue(k) ==
    /\ s.running /\ s.rows[k].status = "sending" /\ ~s.rows[k].bodyIssued
    /\ (s.rows[k].payload = "text" \/ s.rows[k].attribution = "delivered")
    /\ s.rows[k].bodyAttempts < 2
    /\ s' = [s EXCEPT !.rows[k].bodyIssued = TRUE, !.rows[k].bodyAttempts = @ + 1]

BodyResult(k, result) ==
    /\ s.running /\ s.rows[k].status = "sending" /\ s.rows[k].bodyIssued
    /\ s' = [s EXCEPT !.rows[k].status = result]

Disconnect ==
    /\ s.online
    /\ s' = [s EXCEPT !.online = FALSE, !.reply = NoReply]

Reconnect ==
    /\ s.running /\ ~s.online
    /\ s' = [s EXCEPT !.online = TRUE]

Crash ==
    /\ s.running
    /\ s' = [s EXCEPT !.running = FALSE, !.online = FALSE, !.reply = NoReply]

Restart ==
    /\ ~s.running
    /\ s' = [s EXCEPT !.running = TRUE,
              !.rows = [k \in Keys |->
                [s.rows[k] EXCEPT !.status = IF @ = "sending" THEN "unknown" ELSE @,
                 !.attribution = IF @ = "sending" THEN "unknown" ELSE @,
                 !.labelIssued = FALSE, !.bodyIssued = FALSE]]]

Next ==
    (\E k \in Keys, payload \in Payloads : Claim(k, payload) \/ Lookup(k, payload))
    \/ (\E k \in Keys : LabelIssue(k) \/ BodyIssue(k) \/ LabelFailed(k))
    \/ (\E k \in Keys, result \in Terminal : LabelResult(k, result) \/ BodyResult(k, result))
    \/ Disconnect \/ Reconnect \/ Crash \/ Restart

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ s.online \in BOOLEAN /\ s.running \in BOOLEAN /\ (s.online => s.running)
    /\ s.rows \in [Keys -> [payload : Payloads \cup {"none"}, status : ReceiptStates,
                    attribution : ReceiptStates, labelIssued : BOOLEAN, bodyIssued : BOOLEAN,
                    labelAttempts : 0..2, bodyAttempts : 0..2]]
    /\ s.reply \in [kind : {"none", "replay", "conflict"}, key : Keys, row : Keys, payload : Payloads]

AtMostOnce == \A k \in Keys : s.rows[k].labelAttempts <= 1 /\ s.rows[k].bodyAttempts <= 1
ClaimBeforeEffect == \A k \in Keys :
    s.rows[k].labelAttempts + s.rows[k].bodyAttempts > 0 => s.rows[k].payload \in Payloads
AttributionBeforeImage == \A k \in Keys :
    s.rows[k].payload = "image" /\ s.rows[k].bodyAttempts > 0 => s.rows[k].attribution = "delivered"
CorrectReply ==
    s.reply.kind # "none" =>
        /\ s.reply.key = s.reply.row
        /\ (s.reply.kind = "replay") = (s.rows[s.reply.key].payload = s.reply.payload)
StableClaimAndReceipt == [][\A k \in Keys :
    /\ (s.rows[k].payload # "none" => s'.rows[k].payload = s.rows[k].payload)
    /\ (s.rows[k].status \in Terminal => s'.rows[k].status = s.rows[k].status)]_vars
=========================================================================
