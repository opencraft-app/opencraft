-------------------------- MODULE CreditWindow --------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS Ops, Window, ByteBudget, Weight, RefundOnTimeout, one, two, three
Weights == [i \in Ops |-> IF i = two THEN 2 ELSE 1]
VARIABLES unsent, pending, unknown, dispatched, wire, ack, held, retired
vars == <<unsent, pending, unknown, dispatched, wire, ack, held, retired>>
Elements(q) == {q[n] : n \in 1..Len(q)}
RECURSIVE Bytes(_)
Bytes(s) ==
  IF s = {} THEN 0
  ELSE LET i == CHOOSE j \in s : TRUE IN Weight[i] + Bytes(s \ {i})
Init ==
  /\ unsent = Ops /\ pending = {} /\ unknown = {} /\ dispatched = {}
  /\ wire = <<>> /\ ack = {} /\ held = {} /\ retired = FALSE
Send(i) ==
  /\ ~retired /\ i \in unsent
  /\ Cardinality(held) < Window
  /\ Bytes(held) + Weight[i] <= ByteBudget
  /\ unsent' = unsent \ {i}
  /\ pending' = pending \cup {i}
  /\ held' = held \cup {i}
  /\ wire' = Append(wire, i)
  /\ UNCHANGED <<unknown, dispatched, ack, retired>>
Timeout(i) ==
  /\ i \in pending
  /\ pending' = pending \ {i}
  /\ unknown' = unknown \cup {i}
  /\ held' = IF RefundOnTimeout THEN held \ {i} ELSE held
  /\ UNCHANGED <<unsent, dispatched, wire, ack, retired>>
Consume ==
  /\ Len(wire) > 0
  /\ ack' = ack \cup {Head(wire)}
  /\ wire' = Tail(wire)
  /\ UNCHANGED <<unsent, pending, unknown, dispatched, held, retired>>
DeliverAck(i) ==
  /\ i \in ack
  /\ ack' = ack \ {i}
  /\ held' = held \ {i}
  /\ pending' = pending \ {i}
  /\ dispatched' = IF i \in pending THEN dispatched \cup {i} ELSE dispatched
  /\ UNCHANGED <<unsent, unknown, wire, retired>>
Retire ==
  /\ ~retired
  \* Abstract retirement assumes both ends have discarded this connection's
  \* buffers. Merely calling close() locally is not this synchronization.
  /\ retired' = TRUE /\ wire' = <<>> /\ ack' = {} /\ held' = {}
  /\ unknown' = unknown \cup pending /\ pending' = {}
  /\ UNCHANGED <<unsent, dispatched>>
Next == (\E i \in Ops : Send(i) \/ Timeout(i) \/ DeliverAck(i)) \/ Consume \/ Retire
Spec == Init /\ [][Next]_vars
TypeOK ==
  /\ unsent \subseteq Ops /\ pending \subseteq Ops /\ unknown \subseteq Ops
  /\ dispatched \subseteq Ops /\ held \subseteq Ops /\ ack \subseteq Ops
  /\ wire \in Seq(Ops) /\ retired \in BOOLEAN
  /\ Len(wire) = Cardinality(Elements(wire))
ActualWindowBound == Cardinality(Elements(wire) \cup ack) <= Window
ActualByteBound == Bytes(Elements(wire) \cup ack) <= ByteBudget
CreditAccounting == held = Elements(wire) \cup ack
NoUnknownPromotion == unknown \cap dispatched = {}
=============================================================================
