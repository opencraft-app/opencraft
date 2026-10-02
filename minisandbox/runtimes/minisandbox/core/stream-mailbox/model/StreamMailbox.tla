----------------------------- MODULE StreamMailbox -----------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANT Slots

VARIABLES session, phase, cap, txOwner, rxOwner

vars == <<session, phase, cap, txOwner, rxOwner>>

Init ==
    /\ session = 1
    /\ phase = "Running"
    /\ cap = "Free"
    /\ txOwner = [s \in Slots |-> "Guest"]
    /\ rxOwner = [s \in Slots |-> "Host"]

HostOpen ==
    /\ phase = "Running"
    /\ cap = "Free"
    /\ cap' = "Open"
    /\ UNCHANGED <<session, phase, txOwner, rxOwner>>

SubmitTx(s) ==
    /\ phase = "Running"
    /\ cap = "Open"
    /\ txOwner[s] = "Guest"
    /\ txOwner' = [txOwner EXCEPT ![s] = "Host"]
    /\ UNCHANGED <<session, phase, cap, rxOwner>>

CompleteTx(s) ==
    /\ txOwner[s] = "Host"
    /\ txOwner' = [txOwner EXCEPT ![s] = "Guest"]
    /\ UNCHANGED <<session, phase, cap, rxOwner>>

PublishRx(s) ==
    /\ phase = "Running"
    /\ cap = "Open"
    /\ rxOwner[s] = "Host"
    /\ rxOwner' = [rxOwner EXCEPT ![s] = "Guest"]
    /\ UNCHANGED <<session, phase, cap, txOwner>>

ReleaseRx(s) ==
    /\ phase = "Running"
    /\ cap \in {"Open", "Closing"}
    /\ rxOwner[s] = "Guest"
    /\ rxOwner' = [rxOwner EXCEPT ![s] = "Host"]
    /\ UNCHANGED <<session, phase, cap, txOwner>>

BeginClose ==
    /\ phase = "Running"
    /\ cap = "Open"
    /\ cap' = "Closing"
    /\ UNCHANGED <<session, phase, txOwner, rxOwner>>

BeginReset ==
    /\ phase = "Running"
    /\ phase' = "Resetting"
    /\ cap' = IF cap = "Open" THEN "Closing" ELSE cap
    /\ rxOwner' = [s \in Slots |-> "Host"]
    /\ UNCHANGED <<session, txOwner>>

DrainClose ==
    /\ cap = "Closing"
    /\ \A s \in Slots : txOwner[s] = "Guest" /\ rxOwner[s] = "Host"
    /\ cap' = "Free"
    /\ UNCHANGED <<session, phase, txOwner, rxOwner>>

FinishReset ==
    /\ phase = "Resetting"
    /\ cap = "Free"
    /\ \A s \in Slots : txOwner[s] = "Guest" /\ rxOwner[s] = "Host"
    /\ session' = session + 1
    /\ phase' = "Running"
    /\ UNCHANGED <<cap, txOwner, rxOwner>>

Next ==
    \/ HostOpen
    \/ BeginClose
    \/ BeginReset
    \/ DrainClose
    \/ FinishReset
    \/ \E s \in Slots : SubmitTx(s)
    \/ \E s \in Slots : CompleteTx(s)
    \/ \E s \in Slots : PublishRx(s)
    \/ \E s \in Slots : ReleaseRx(s)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ session \in Nat \ {0}
    /\ phase \in {"Running", "Resetting"}
    /\ cap \in {"Free", "Open", "Closing"}
    /\ txOwner \in [Slots -> {"Guest", "Host"}]
    /\ rxOwner \in [Slots -> {"Host", "Guest"}]

ResetHasNoOpenCapability == phase = "Resetting" => cap # "Open"

FreeCapabilityHasNoOutstandingOwnership ==
    cap = "Free" =>
        \A s \in Slots : txOwner[s] = "Guest" /\ rxOwner[s] = "Host"

=============================================================================
