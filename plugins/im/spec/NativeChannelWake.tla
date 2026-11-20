------------------------- MODULE NativeChannelWake -------------------------
EXTENDS Naturals, FiniteSets

CONSTANT Bots
VARIABLES online, members, epoch, committed, accepted, phase, claims, claimedEpoch
vars == <<online, members, epoch, committed, accepted, phase, claims, claimedEpoch>>

Init ==
    /\ online = TRUE
    /\ members = Bots
    /\ epoch = [b \in Bots |-> 1]
    /\ committed = FALSE
    /\ accepted = [b \in Bots |-> 0]
    /\ phase = [b \in Bots |-> "absent"]
    /\ claims = [b \in Bots |-> 0]
    /\ claimedEpoch = [b \in Bots |-> 0]

\* One send key. Retrying the same payload observes the same durable operation.
Commit(targets) ==
    /\ online /\ ~committed /\ targets \subseteq members
    /\ committed' = TRUE
    /\ accepted' = [b \in Bots |-> IF b \in targets THEN epoch[b] ELSE 0]
    /\ phase' = [b \in Bots |-> IF b \in targets THEN "pending" ELSE "absent"]
    /\ UNCHANGED <<online, members, epoch, claims, claimedEpoch>>

Retry == online /\ committed /\ UNCHANGED vars

ToggleMember(b) ==
    /\ online /\ epoch[b] < 3
    /\ members' = IF b \in members THEN members \ {b} ELSE members \cup {b}
    /\ epoch' = [epoch EXCEPT ![b] = @ + 1]
    /\ UNCHANGED <<online, committed, accepted, phase, claims, claimedEpoch>>

CanClaim(b) == b \in members /\ accepted[b] = epoch[b]

Claim(b) ==
    /\ online /\ phase[b] = "pending" /\ CanClaim(b)
    /\ phase' = [phase EXCEPT ![b] = "claimed"]
    /\ claims' = [claims EXCEPT ![b] = @ + 1]
    /\ claimedEpoch' = [claimedEpoch EXCEPT ![b] = epoch[b]]
    /\ UNCHANGED <<online, members, epoch, committed, accepted>>

Reject(b) ==
    /\ online /\ phase[b] = "pending" /\ ~CanClaim(b)
    /\ phase' = [phase EXCEPT ![b] = "rejected"]
    /\ UNCHANGED <<online, members, epoch, committed, accepted, claims, claimedEpoch>>

RestartBoundary == online' = ~online /\ UNCHANGED <<members, epoch, committed, accepted, phase, claims, claimedEpoch>>

Next ==
    \/ \E targets \in SUBSET Bots : Commit(targets)
    \/ \E b \in Bots : ToggleMember(b) \/ Claim(b) \/ Reject(b)
    \/ Retry
    \/ RestartBoundary

Spec == Init /\ [][Next]_vars

AtomicCommit == \A b \in Bots : (accepted[b] # 0) <=> (committed /\ phase[b] # "absent")
AtMostOnce == \A b \in Bots : claims[b] <= 1
AuthorizedClaim == \A b \in Bots : claims[b] > 0 => claimedEpoch[b] = accepted[b]
=============================================================================
