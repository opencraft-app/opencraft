--------------------------- MODULE CbsTxnLog ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Operations, MaxCommits, Mutation

NoOp == "NoOp"
Empty == "Empty"
Torn == "Torn"

ASSUME /\ Operations # {}
       /\ NoOp \notin Operations
       /\ Empty \notin Operations
       /\ Torn \notin Operations
       /\ MaxCommits \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "AckBeforeSync",
            "CommitBeforeData",
            "AcceptTornRecord",
            "DuplicateRetry"
          }

Phases == {"Idle", "DataWritten", "DataSynced", "CommitWritten", "CommitSynced"}
SlotValues == Operations \cup {Empty, Torn}

VARIABLES
    running,
    nextVersion,
    phase,
    activeOp,
    dataDisk,
    commitDisk,
    issuedOps,
    committedOps,
    ackedOps,
    unsafeRecovery

vars == <<
    running,
    nextVersion,
    phase,
    activeOp,
    dataDisk,
    commitDisk,
    issuedOps,
    committedOps,
    ackedOps,
    unsafeRecovery
>>

ValidSlot(version) ==
    /\ dataDisk[version] \in Operations
    /\ commitDisk[version] = dataDisk[version]

PrefixCandidates ==
    {last \in 0..MaxCommits :
        \A version \in 1..last : ValidSlot(version)}

DurablePrefix ==
    CHOOSE last \in PrefixCandidates :
        \A candidate \in PrefixCandidates : last >= candidate

DurableOps ==
    {dataDisk[version] : version \in 1..DurablePrefix}

TornCommittedOps ==
    {commitDisk[version] :
        version \in {
            candidate \in 1..MaxCommits :
                /\ dataDisk[candidate] = Torn
                /\ commitDisk[candidate] \in Operations
        }}

Init ==
    /\ running = TRUE
    /\ nextVersion = 1
    /\ phase = "Idle"
    /\ activeOp = NoOp
    /\ dataDisk = [version \in 1..MaxCommits |-> Empty]
    /\ commitDisk = [version \in 1..MaxCommits |-> Empty]
    /\ issuedOps = {}
    /\ committedOps = {}
    /\ ackedOps = {}
    /\ unsafeRecovery = FALSE

WriteData(operation) ==
    /\ running
    /\ phase = "Idle"
    /\ nextVersion <= MaxCommits
    /\ \/ operation \notin committedOps
       \/ Mutation = "DuplicateRetry"
    /\ activeOp' = operation
    /\ phase' = "DataWritten"
    /\ issuedOps' = issuedOps \cup {operation}
    /\ UNCHANGED <<
           running, nextVersion, dataDisk, commitDisk,
           committedOps, ackedOps, unsafeRecovery
       >>

SyncData ==
    /\ running
    /\ phase = "DataWritten"
    /\ dataDisk' = [dataDisk EXCEPT ![nextVersion] = activeOp]
    /\ phase' = "DataSynced"
    /\ UNCHANGED <<
           running, nextVersion, activeOp, commitDisk, issuedOps,
           committedOps, ackedOps, unsafeRecovery
       >>

WriteCommit ==
    /\ running
    /\ \/ phase = "DataSynced"
       \/ /\ Mutation \in {"CommitBeforeData", "AcceptTornRecord"}
          /\ phase = "DataWritten"
    /\ phase' = "CommitWritten"
    /\ UNCHANGED <<
           running, nextVersion, activeOp, dataDisk, commitDisk,
           issuedOps, committedOps, ackedOps, unsafeRecovery
       >>

SyncCommit ==
    /\ running
    /\ phase = "CommitWritten"
    /\ commitDisk' = [commitDisk EXCEPT ![nextVersion] = activeOp]
    /\ committedOps' = committedOps \cup {activeOp}
    /\ phase' = "CommitSynced"
    /\ UNCHANGED <<
           running, nextVersion, activeOp, dataDisk, issuedOps,
           ackedOps, unsafeRecovery
       >>

FinishResponse(acknowledged) ==
    /\ nextVersion' = nextVersion + 1
    /\ phase' = "Idle"
    /\ activeOp' = NoOp
    /\ ackedOps' =
           IF acknowledged THEN ackedOps \cup {activeOp} ELSE ackedOps
    /\ UNCHANGED <<
           running, dataDisk, commitDisk, issuedOps,
           committedOps, unsafeRecovery
       >>

AckCommit ==
    /\ running
    /\ \/ phase = "CommitSynced"
       \/ /\ Mutation = "AckBeforeSync"
          /\ phase = "CommitWritten"
    /\ FinishResponse(TRUE)

LoseCommitReply ==
    /\ running
    /\ phase = "CommitSynced"
    /\ FinishResponse(FALSE)

RetryKnown(operation) ==
    /\ running
    /\ phase = "Idle"
    /\ operation \in committedOps
    /\ operation \notin ackedOps
    /\ ackedOps' = ackedOps \cup {operation}
    /\ UNCHANGED <<
           running, nextVersion, phase, activeOp, dataDisk, commitDisk,
           issuedOps, committedOps, unsafeRecovery
       >>

GoDown(dataAfter, commitAfter) ==
    /\ running' = FALSE
    /\ nextVersion' = 1
    /\ phase' = "Idle"
    /\ activeOp' = NoOp
    /\ dataDisk' = dataAfter
    /\ commitDisk' = commitAfter
    /\ committedOps' = {}
    /\ UNCHANGED <<issuedOps, ackedOps, unsafeRecovery>>

CrashLoseCaches ==
    /\ running
    /\ GoDown(dataDisk, commitDisk)

CrashPersistData ==
    /\ running
    /\ phase = "DataWritten"
    /\ GoDown([dataDisk EXCEPT ![nextVersion] = activeOp], commitDisk)

CrashTornData ==
    /\ running
    /\ phase = "DataWritten"
    /\ GoDown([dataDisk EXCEPT ![nextVersion] = Torn], commitDisk)

CrashPersistCommit ==
    /\ running
    /\ phase = "CommitWritten"
    /\ GoDown(dataDisk, [commitDisk EXCEPT ![nextVersion] = activeOp])

CrashTornCommit ==
    /\ running
    /\ phase = "CommitWritten"
    /\ GoDown(dataDisk, [commitDisk EXCEPT ![nextVersion] = Torn])

CrashTornDataAndPersistCommit ==
    /\ running
    /\ Mutation = "AcceptTornRecord"
    /\ phase = "CommitWritten"
    /\ GoDown(
           [dataDisk EXCEPT ![nextVersion] = Torn],
           [commitDisk EXCEPT ![nextVersion] = activeOp])

Recover ==
    /\ ~running
    /\ running' = TRUE
    /\ nextVersion' = DurablePrefix + 1
    /\ committedOps' =
           IF Mutation = "AcceptTornRecord"
           THEN DurableOps \cup TornCommittedOps
           ELSE DurableOps
    /\ unsafeRecovery' =
           (unsafeRecovery \/
            /\ Mutation = "AcceptTornRecord"
            /\ TornCommittedOps # {})
    /\ UNCHANGED <<
           phase, activeOp, dataDisk, commitDisk,
           issuedOps, ackedOps
       >>

Next ==
    \/ \E operation \in Operations : WriteData(operation)
    \/ SyncData
    \/ WriteCommit
    \/ SyncCommit
    \/ AckCommit
    \/ LoseCommitReply
    \/ \E operation \in Operations : RetryKnown(operation)
    \/ CrashLoseCaches
    \/ CrashPersistData
    \/ CrashTornData
    \/ CrashPersistCommit
    \/ CrashTornCommit
    \/ CrashTornDataAndPersistCommit
    \/ Recover

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ running \in BOOLEAN
    /\ nextVersion \in 1..(MaxCommits + 1)
    /\ phase \in Phases
    /\ activeOp \in Operations \cup {NoOp}
    /\ dataDisk \in [1..MaxCommits -> SlotValues]
    /\ commitDisk \in [1..MaxCommits -> SlotValues]
    /\ issuedOps \subseteq Operations
    /\ committedOps \subseteq Operations
    /\ ackedOps \subseteq Operations
    /\ unsafeRecovery \in BOOLEAN

AcknowledgedTransactionsRecover ==
    ackedOps \subseteq DurableOps

CommittedMemoryIsDurable ==
    committedOps \subseteq DurableOps

DurableTransactionsWereIssued ==
    DurableOps \subseteq issuedOps

OperationIdsCommitAtMostOnce ==
    \A left \in 1..DurablePrefix, right \in 1..DurablePrefix :
        dataDisk[left] = dataDisk[right] => left = right

TornRecordsAreRejected == ~unsafeRecovery

Safety ==
    /\ TypeOK
    /\ AcknowledgedTransactionsRecover
    /\ CommittedMemoryIsDurable
    /\ DurableTransactionsWereIssued
    /\ OperationIdsCommitAtMostOnce
    /\ TornRecordsAreRejected

=============================================================================
