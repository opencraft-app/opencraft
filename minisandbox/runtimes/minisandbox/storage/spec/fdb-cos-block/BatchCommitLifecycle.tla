------------------------ MODULE BatchCommitLifecycle ------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Ops, Blocks, Values, ZeroValue, MaxEpoch, Mutation

Phases == {"Fresh", "Queued", "Batched", "InFlight", "Durable", "Replied"}
Results == {"None", "Applied", "Stale"}

ASSUME /\ Ops # {}
       /\ Blocks # {}
       /\ Values # {}
       /\ ZeroValue \in Values
       /\ MaxEpoch \in Nat \ {0}
       /\ Mutation \in {"None", "PartialCommit", "AckBeforeCommit",
                           "IgnoreEpochFence"}

VARIABLES
    currentEpoch,
    phase,
    opEpoch,
    result,
    applied,
    version,
    nextVersion,
    batch,
    batchEpoch,
    cohort,
    head,
    acknowledged,
    flushAcked,
    flushCut,
    snapshotTaken,
    snapshotHead,
    staleApplied

vars == <<
    currentEpoch, phase, opEpoch, result, applied, version, nextVersion,
    batch, batchEpoch, cohort, head, acknowledged, flushAcked, flushCut,
    snapshotTaken, snapshotHead, staleApplied
>>

NoEpoch == 0

Pending == {op \in Ops : phase[op] \in {"Queued", "Batched", "InFlight"}}
Submitted == {op \in Ops : phase[op] # "Fresh"}

TargetBlock == CHOOSE block \in Blocks : TRUE
DataValue == CHOOSE value \in Values \ {ZeroValue} : TRUE

Candidates(block) ==
    IF block = TargetBlock THEN {op \in Ops : applied[op]} ELSE {}

Latest(block) ==
    CHOOSE op \in Candidates(block) :
        \A other \in Candidates(block) : version[op] >= version[other]

ExpectedHead(block) ==
    IF Candidates(block) = {} THEN ZeroValue ELSE DataValue

ApplyMembers(oldHead, members) ==
    [block \in Blocks |->
        IF members # {} /\ block = TargetBlock THEN DataValue ELSE oldHead[block]]

Init ==
    /\ currentEpoch = 1
    /\ phase = [op \in Ops |-> "Fresh"]
    /\ opEpoch = [op \in Ops |-> NoEpoch]
    /\ result = [op \in Ops |-> "None"]
    /\ applied = [op \in Ops |-> FALSE]
    /\ version = [op \in Ops |-> 0]
    /\ nextVersion = 0
    /\ batch = {}
    /\ batchEpoch = NoEpoch
    /\ cohort = [op \in Ops |-> {}]
    /\ head = [block \in Blocks |-> ZeroValue]
    /\ acknowledged = [op \in Ops |-> FALSE]
    /\ flushAcked = FALSE
    /\ flushCut = {}
    /\ snapshotTaken = FALSE
    /\ snapshotHead = [block \in Blocks |-> ZeroValue]
    /\ staleApplied = FALSE

Submit(op, requestedEpoch) ==
    /\ phase[op] = "Fresh"
    /\ requestedEpoch \in 1..MaxEpoch
    /\ phase' = [phase EXCEPT ![op] = "Queued"]
    /\ opEpoch' = [opEpoch EXCEPT ![op] = requestedEpoch]
    /\ UNCHANGED <<
           currentEpoch, result, applied, version, nextVersion, batch,
           batchEpoch, cohort, head, acknowledged, flushAcked, flushCut,
           snapshotTaken, snapshotHead, staleApplied
       >>

Collect(requestedEpoch, members) ==
    /\ batch = {}
    /\ members # {}
    /\ members \subseteq {op \in Ops :
                              phase[op] = "Queued" /\ opEpoch[op] = requestedEpoch}
    /\ phase' = [op \in Ops |-> IF op \in members THEN "Batched" ELSE phase[op]]
    /\ batch' = members
    /\ batchEpoch' = requestedEpoch
    /\ cohort' = [op \in Ops |-> IF op \in members THEN members ELSE cohort[op]]
    /\ UNCHANGED <<
           currentEpoch, opEpoch, result, applied, version, nextVersion, head,
           acknowledged, flushAcked, flushCut, snapshotTaken, snapshotHead,
           staleApplied
       >>

BeginCommit ==
    /\ batch # {}
    /\ \A op \in batch : phase[op] = "Batched"
    /\ phase' = [op \in Ops |-> IF op \in batch THEN "InFlight" ELSE phase[op]]
    /\ UNCHANGED <<
           currentEpoch, opEpoch, result, applied, version, nextVersion,
           batch, batchEpoch, cohort, head, acknowledged, flushAcked,
           flushCut, snapshotTaken, snapshotHead, staleApplied
       >>

CommitBatch ==
    /\ batch # {}
    /\ \A op \in batch : phase[op] = "InFlight"
    /\ Mutation # "PartialCommit"
    /\ phase' = [op \in Ops |-> IF op \in batch THEN "Durable" ELSE phase[op]]
    /\ IF (batchEpoch = currentEpoch) \/ (Mutation = "IgnoreEpochFence")
       THEN /\ result' = [op \in Ops |->
                              IF op \in batch THEN "Applied" ELSE result[op]]
            /\ applied' = [op \in Ops |-> applied[op] \/ op \in batch]
            /\ version' = [op \in Ops |->
                               IF op \in batch THEN nextVersion + 1 ELSE version[op]]
            /\ nextVersion' = nextVersion + 1
            /\ head' = ApplyMembers(head, batch)
            /\ staleApplied' =
                   IF batchEpoch # currentEpoch THEN TRUE ELSE staleApplied
       ELSE /\ result' = [op \in Ops |->
                              IF op \in batch THEN "Stale" ELSE result[op]]
            /\ UNCHANGED <<applied, version, nextVersion, head, staleApplied>>
    /\ batch' = {}
    /\ batchEpoch' = NoEpoch
    /\ UNCHANGED <<
           currentEpoch, opEpoch, cohort, acknowledged, flushAcked, flushCut,
           snapshotTaken, snapshotHead
       >>

CommitPartial ==
    LET chosen == CHOOSE op \in batch : TRUE IN
    /\ Mutation = "PartialCommit"
    /\ Cardinality(batch) > 1
    /\ \A op \in batch : phase[op] = "InFlight"
    /\ phase' = [op \in Ops |->
                     IF op = chosen THEN "Durable"
                     ELSE IF op \in batch THEN "Queued" ELSE phase[op]]
    /\ result' = [result EXCEPT ![chosen] = "Applied"]
    /\ applied' = [applied EXCEPT ![chosen] = TRUE]
    /\ version' = [version EXCEPT ![chosen] = nextVersion + 1]
    /\ nextVersion' = nextVersion + 1
    /\ head' = ApplyMembers(head, {chosen})
    /\ batch' = {}
    /\ batchEpoch' = NoEpoch
    /\ UNCHANGED <<
           currentEpoch, opEpoch, cohort, acknowledged, flushAcked, flushCut,
           snapshotTaken, snapshotHead, staleApplied
       >>

CrashUncommitted ==
    /\ batch # {}
    /\ \A op \in batch : phase[op] \in {"Batched", "InFlight"}
    /\ phase' = [op \in Ops |-> IF op \in batch THEN "Queued" ELSE phase[op]]
    /\ batch' = {}
    /\ batchEpoch' = NoEpoch
    /\ UNCHANGED <<
           currentEpoch, opEpoch, result, applied, version, nextVersion,
           cohort, head, acknowledged, flushAcked, flushCut, snapshotTaken,
           snapshotHead, staleApplied
       >>

Reply(op) ==
    /\ result[op] # "None"
    /\ phase[op] = "Durable"
    /\ phase' = [phase EXCEPT ![op] = "Replied"]
    /\ acknowledged' = [acknowledged EXCEPT ![op] = TRUE]
    /\ UNCHANGED <<
           currentEpoch, opEpoch, result, applied, version, nextVersion,
           batch, batchEpoch, cohort, head, flushAcked, flushCut,
           snapshotTaken, snapshotHead, staleApplied
       >>

ReplyBeforeCommit(op) ==
    /\ Mutation = "AckBeforeCommit"
    /\ phase[op] = "InFlight"
    /\ phase' = [phase EXCEPT ![op] = "Replied"]
    /\ acknowledged' = [acknowledged EXCEPT ![op] = TRUE]
    /\ UNCHANGED <<
           currentEpoch, opEpoch, result, applied, version, nextVersion,
           batch, batchEpoch, cohort, head, flushAcked, flushCut,
           snapshotTaken, snapshotHead, staleApplied
       >>

Flush ==
    /\ ~flushAcked
    /\ IF Mutation = "AckBeforeCommit" THEN TRUE ELSE Pending = {}
    /\ flushCut' = Submitted
    /\ flushAcked' = TRUE
    /\ UNCHANGED <<
           currentEpoch, phase, opEpoch, result, applied, version, nextVersion,
           batch, batchEpoch, cohort, head, acknowledged, snapshotTaken,
           snapshotHead, staleApplied
       >>

Snapshot ==
    /\ ~snapshotTaken
    /\ Pending = {}
    /\ currentEpoch < MaxEpoch
    /\ snapshotTaken' = TRUE
    /\ snapshotHead' = head
    /\ currentEpoch' = currentEpoch + 1
    /\ UNCHANGED <<
           phase, opEpoch, result, applied, version, nextVersion, batch,
           batchEpoch, cohort, head, acknowledged, flushAcked, flushCut,
           staleApplied
       >>

Next ==
    \/ \E op \in Ops, requestedEpoch \in 1..MaxEpoch : Submit(op, requestedEpoch)
    \/ \E requestedEpoch \in 1..MaxEpoch, members \in SUBSET Ops :
           Collect(requestedEpoch, members)
    \/ BeginCommit
    \/ CommitBatch
    \/ CommitPartial
    \/ CrashUncommitted
    \/ \E op \in Ops : Reply(op)
    \/ \E op \in Ops : ReplyBeforeCommit(op)
    \/ Flush
    \/ Snapshot

Spec == Init /\ [][Next]_vars

=============================================================================
