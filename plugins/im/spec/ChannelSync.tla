-------------------------- MODULE ChannelSync --------------------------
EXTENDS Naturals
CONSTANT Fault

(* Three message identities. State 0 means absent, 1 means inserted and
   2 means its attachment is ready. A write replaces the latest revision
   for that identity, just like the SQLite change index. *)
Messages == 1..3
Empty == [m \in Messages |-> 0]
NoPage == [pending |-> FALSE, cursor |-> 0, items |-> {},
           values |-> Empty, more |-> FALSE]

VARIABLE s
vars == <<s>>

Init ==
    s = [value |-> Empty, revision |-> Empty, clock |-> 0,
         view |-> Empty, cursor |-> 0, hydrated |-> FALSE,
         online |-> TRUE, wake |-> TRUE, reply |-> NoPage,
         demanded |-> Empty]

Commit(m, hint) ==
    /\ s.value[m] < 2
    /\ LET value == [s.value EXCEPT ![m] = @ + 1]
           notify == s.online /\ hint
       IN s' = [s EXCEPT !.value = value, !.clock = @ + 1,
                  !.revision[m] = IF Fault = "missing-update" /\ s.value[m] = 1
                                  THEN @ ELSE s.clock + 1,
                  !.wake = @ \/ notify,
                  !.demanded = IF notify THEN value ELSE @]

DropLink ==
    /\ s.online
    /\ s' = [s EXCEPT !.online = FALSE, !.reply = NoPage, !.wake = FALSE,
                  !.demanded = Empty]

(* The durable index and client view survive reconnect. A pending response
   belongs to the retired connection and can no longer be applied. *)
Reconnect ==
    /\ ~s.online
    /\ s' = [s EXCEPT !.online = TRUE,
                  !.wake = Fault # "missing-reconnect-wake",
                  !.demanded = s.value]

AfterCursor == {m \in Messages : s.revision[m] > s.cursor}
Earliest == CHOOSE m \in AfterCursor :
    \A n \in AfterCursor : s.revision[m] <= s.revision[n]

(* A delta has room for one message. The full recent snapshot fits in this
   model. The cursor and message values come from the same database cut. *)
ReadPage ==
    IF ~s.hydrated
    THEN [pending |-> TRUE, cursor |-> s.clock, items |-> Messages,
          values |-> s.value, more |-> FALSE]
    ELSE IF AfterCursor = {}
         THEN [NoPage EXCEPT !.pending = TRUE, !.cursor = s.cursor]
         ELSE [pending |-> TRUE,
               cursor |-> IF Fault = "skip-page" THEN s.clock ELSE s.revision[Earliest],
               items |-> {Earliest}, values |-> s.value,
               more |-> AfterCursor # {Earliest}]

Fetch ==
    /\ s.online /\ s.wake /\ ~s.reply.pending
    /\ s' = [s EXCEPT !.reply = ReadPage, !.wake = FALSE]

Apply ==
    /\ s.online /\ s.reply.pending
    /\ s' = [s EXCEPT
          !.view = [m \in Messages |-> IF m \in s.reply.items
                                         THEN s.reply.values[m] ELSE s.view[m]],
          !.cursor = s.reply.cursor, !.hydrated = TRUE,
          !.wake = IF Fault = "drop-queued-wake" THEN s.reply.more ELSE @ \/ s.reply.more,
          !.reply = NoPage]

Next ==
    (\E m \in Messages, hint \in BOOLEAN : Commit(m, hint))
    \/ DropLink \/ Reconnect \/ Fetch \/ Apply

Spec == Init /\ [][Next]_vars /\ WF_vars(Fetch) /\ WF_vars(Apply)

TypeOK ==
    /\ s.value \in [Messages -> 0..2] /\ s.view \in [Messages -> 0..2]
    /\ s.revision \in [Messages -> 0..6] /\ s.clock \in 0..6
    /\ s.cursor \in 0..s.clock /\ s.hydrated \in BOOLEAN
    /\ s.online \in BOOLEAN /\ s.wake \in BOOLEAN
    /\ s.reply \in [pending : BOOLEAN, cursor : 0..s.clock,
                    items : SUBSET Messages, values : [Messages -> 0..2], more : BOOLEAN]
    /\ s.demanded \in [Messages -> 0..2]

NoPhantomProjection == \A m \in Messages : s.view[m] <= s.value[m]
CursorSound == \A m \in Messages : s.revision[m] <= s.cursor => s.view[m] = s.value[m]
MonotoneView == [][s'.cursor >= s.cursor /\
    (\A m \in Messages : s'.view[m] >= s.view[m])]_vars

CaughtUp == \A m \in Messages : s.view[m] >= s.demanded[m]
(* A new disconnect ends the current connection's obligation. The next
   reconnect creates a new obligation, even if every offline hint was lost. *)
CatchUp == (s.online /\ ~CaughtUp) ~> (~s.online \/ CaughtUp)
=========================================================================
