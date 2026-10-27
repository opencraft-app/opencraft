-------------------------- MODULE MediaRecovery --------------------------
EXTENDS Naturals, TLC
CONSTANTS Window, RefundAtReset, AcceptStale, UnlimitedRecovery, Progress
VARIABLES epoch, ready, closed, held, actual, attempts
vars == <<epoch, ready, closed, held, actual, attempts>>
Init == /\ epoch = 0 /\ ready = TRUE /\ closed = FALSE
        /\ held = 1 /\ actual = 1 /\ attempts = 0
Send == /\ ready /\ ~closed /\ held < Window
        /\ held' = held + 1 /\ actual' = actual + 1
        /\ UNCHANGED <<epoch, ready, closed, attempts>>
Ack == /\ Progress /\ ready /\ ~closed /\ actual > 0
       /\ actual' = actual - 1 /\ held' = held - 1 /\ attempts' = 0
       /\ UNCHANGED <<epoch, ready, closed>>
Reset == /\ ready /\ ~closed /\ actual > 0
         /\ IF attempts = 3 /\ ~UnlimitedRecovery
            THEN /\ closed' = TRUE
                 /\ UNCHANGED <<epoch, ready, held, actual, attempts>>
            ELSE /\ epoch' = IF epoch = 4 THEN 0 ELSE epoch + 1
                 /\ ready' = FALSE
                 /\ attempts' = IF attempts = 3 THEN 3 ELSE attempts + 1
                 /\ held' = IF RefundAtReset THEN 0 ELSE held
                 /\ UNCHANGED <<closed, actual>>
\* This action assumes the receiver actually discarded old decoder work before ready.
Confirm == /\ ~ready /\ ~closed
           /\ held' = 0 /\ actual' = 0 /\ ready' = TRUE
           /\ UNCHANGED <<epoch, closed, attempts>>
StaleAck == /\ AcceptStale /\ ~closed /\ ~ready /\ held > 0
            /\ held' = held - 1
            /\ UNCHANGED <<epoch, ready, closed, actual, attempts>>
HandshakeTimeout == /\ ~ready /\ ~closed /\ closed' = TRUE
                    /\ UNCHANGED <<epoch, ready, held, actual, attempts>>
Next == Send \/ Ack \/ Reset \/ Confirm \/ StaleAck \/ HandshakeTimeout
Spec == Init /\ [][Next]_vars /\ WF_vars(Send) /\ WF_vars(Reset)
        /\ WF_vars(Confirm) /\ WF_vars(HandshakeTimeout)
TypeOK == /\ epoch \in 0..4 /\ attempts \in 0..3
          /\ held \in 0..Window /\ actual \in 0..Window
          /\ ready \in BOOLEAN /\ closed \in BOOLEAN
NoUnconfirmedRefund == held = actual
BoundedDebt == actual <= Window
NoProgressTerminates == ~Progress => <>closed
=============================================================================
