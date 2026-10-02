------------------------- MODULE SqliteMetaStore -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Operations,
    Attempts,
    Readers,
    CasOperations,
    MaxEpoch,
    MaxCommits,
    Mutation

NoOp == "NoOp"
NoAttempt == "NoAttempt"
NoVersion == 0
NoOutcome == "NoOutcome"
Outcomes == {NoOutcome, "Applied", "ConditionFailed", "StaleEpoch"}

AttemptStates == {
    "Free",
    "Queued",
    "AbandonedQueued",
    "Executing",
    "AbandonedExecuting",
    "Committed",
    "Replayed",
    "LostCommitted",
    "Responded",
    "Aborted"
}

ReaderStates == {"Idle", "Active", "Completed", "Aborted"}

ASSUME /\ Operations # {}
       /\ Attempts # {}
       /\ Readers # {}
       /\ CasOperations \subseteq Operations
       /\ NoOp \notin Operations
       /\ NoAttempt \notin Attempts
       /\ MaxEpoch \in Nat \ {0}
       /\ MaxCommits \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "AckBeforeCommit",
            "MissingDedupe",
            "MissingEpochGuard",
            "MissingConditionalGuard",
            "ReuseCommitVersion",
            "StaleRead"
          }

VARIABLES
    running,
    epoch,
    durableVersion,
    submittedOps,
    opEpoch,
    expectedVersion,
    attemptState,
    attemptOp,
    activeAttempt,
    opResult,
    opOutcome,
    committedAttempts,
    attemptVersion,
    attemptCommitEpoch,
    attemptBaseVersion,
    applyCount,
    ackedOps,
    ackVersion,
    readerState,
    readerRequired,
    readerObserved

vars == <<
    running,
    epoch,
    durableVersion,
    submittedOps,
    opEpoch,
    expectedVersion,
    attemptState,
    attemptOp,
    activeAttempt,
    opResult,
    opOutcome,
    committedAttempts,
    attemptVersion,
    attemptCommitEpoch,
    attemptBaseVersion,
    applyCount,
    ackedOps,
    ackVersion,
    readerState,
    readerRequired,
    readerObserved
>>

AckedVersions == {NoVersion} \cup {ackVersion[op] : op \in ackedOps}

LatestAckedVersion ==
    CHOOSE version \in AckedVersions :
        \A candidate \in AckedVersions : candidate <= version

DedupeGuard(op) ==
    \/ opResult[op] = NoVersion
    \/ Mutation = "MissingDedupe"

EpochGuard(op) ==
    \/ opEpoch[op] = epoch
    \/ Mutation = "MissingEpochGuard"

ConditionalGuard(op) ==
    \/ op \notin CasOperations
    \/ expectedVersion[op] = durableVersion
    \/ Mutation = "MissingConditionalGuard"

CanApply(op) ==
    /\ DedupeGuard(op)
    /\ EpochGuard(op)
    /\ ConditionalGuard(op)

NextCommitVersion ==
    IF Mutation = "ReuseCommitVersion" /\ durableVersion > NoVersion
    THEN durableVersion
    ELSE durableVersion + 1

CrashAttemptState(attempt) ==
    IF attemptState[attempt] \in {
        "Queued",
        "AbandonedQueued",
        "Executing",
        "AbandonedExecuting"
    }
    THEN "Aborted"
    ELSE IF attemptState[attempt] \in {"Committed", "Replayed"}
         THEN "LostCommitted"
         ELSE attemptState[attempt]

CrashReaderState(reader) ==
    IF readerState[reader] = "Active"
    THEN "Aborted"
    ELSE readerState[reader]

Init ==
    /\ running = TRUE
    /\ epoch = 1
    /\ durableVersion = NoVersion
    /\ submittedOps = {}
    /\ opEpoch = [op \in Operations |-> 0]
    /\ expectedVersion = [op \in Operations |-> NoVersion]
    /\ attemptState = [attempt \in Attempts |-> "Free"]
    /\ attemptOp = [attempt \in Attempts |-> NoOp]
    /\ activeAttempt = NoAttempt
    /\ opResult = [op \in Operations |-> NoVersion]
    /\ opOutcome = [op \in Operations |-> NoOutcome]
    /\ committedAttempts = {}
    /\ attemptVersion = [attempt \in Attempts |-> NoVersion]
    /\ attemptCommitEpoch = [attempt \in Attempts |-> 0]
    /\ attemptBaseVersion = [attempt \in Attempts |-> NoVersion]
    /\ applyCount = [op \in Operations |-> 0]
    /\ ackedOps = {}
    /\ ackVersion = [op \in Operations |-> NoVersion]
    /\ readerState = [reader \in Readers |-> "Idle"]
    /\ readerRequired = [reader \in Readers |-> NoVersion]
    /\ readerObserved = [reader \in Readers |-> NoVersion]

SubmitOp(op) ==
    /\ running
    /\ op \notin submittedOps
    /\ submittedOps' = submittedOps \cup {op}
    /\ opEpoch' = [opEpoch EXCEPT ![op] = epoch]
    /\ expectedVersion' =
           [expectedVersion EXCEPT ![op] = durableVersion]
    /\ UNCHANGED <<
           running, epoch, durableVersion, attemptState, attemptOp,
           activeAttempt, opResult, opOutcome, committedAttempts, attemptVersion,
           attemptCommitEpoch, attemptBaseVersion, applyCount, ackedOps,
           ackVersion, readerState, readerRequired, readerObserved
       >>

QueueAttempt(op, attempt) ==
    /\ running
    /\ op \in submittedOps
    /\ op \notin ackedOps
    /\ attemptState[attempt] = "Free"
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "Queued"]
    /\ attemptOp' = [attemptOp EXCEPT ![attempt] = op]
    /\ UNCHANGED <<
           running, epoch, durableVersion, submittedOps, opEpoch,
           expectedVersion, activeAttempt, opResult, opOutcome, committedAttempts,
           attemptVersion, attemptCommitEpoch, attemptBaseVersion,
           applyCount, ackedOps, ackVersion, readerState, readerRequired,
           readerObserved
       >>

AbandonAttempt(attempt) ==
    /\ running
    /\ attemptState[attempt] \in {
           "Queued",
           "Executing",
           "Committed",
           "Replayed"
       }
    /\ attemptState' =
           [attemptState EXCEPT
               ![attempt] =
                   IF @ = "Queued"
                   THEN "AbandonedQueued"
                   ELSE IF @ = "Executing"
                        THEN "AbandonedExecuting"
                        ELSE "LostCommitted"]
    /\ UNCHANGED <<
           running, epoch, durableVersion, submittedOps, opEpoch,
           expectedVersion, attemptOp, activeAttempt, opResult, opOutcome,
           committedAttempts, attemptVersion, attemptCommitEpoch,
           attemptBaseVersion, applyCount, ackedOps, ackVersion,
           readerState, readerRequired, readerObserved
       >>

StartWriter(attempt) ==
    /\ running
    /\ activeAttempt = NoAttempt
    /\ attemptState[attempt] \in {"Queued", "AbandonedQueued"}
    /\ activeAttempt' = attempt
    /\ attemptState' =
           [attemptState EXCEPT
               ![attempt] =
                   IF @ = "Queued"
                   THEN "Executing"
                   ELSE "AbandonedExecuting"]
    /\ UNCHANGED <<
           running, epoch, durableVersion, submittedOps, opEpoch,
           expectedVersion, attemptOp, opResult, opOutcome, committedAttempts,
           attemptVersion, attemptCommitEpoch, attemptBaseVersion,
           applyCount, ackedOps, ackVersion, readerState, readerRequired,
           readerObserved
       >>

CommitAttempt(attempt) ==
    LET op == attemptOp[attempt]
        commitVersion == NextCommitVersion
    IN
    /\ running
    /\ activeAttempt = attempt
    /\ attemptState[attempt] \in {"Executing", "AbandonedExecuting"}
    /\ CanApply(op)
    /\ commitVersion <= MaxCommits
    /\ durableVersion' = commitVersion
    /\ opResult' = [opResult EXCEPT ![op] = commitVersion]
    /\ opOutcome' = [opOutcome EXCEPT ![op] = "Applied"]
    /\ committedAttempts' = committedAttempts \cup {attempt}
    /\ attemptVersion' =
           [attemptVersion EXCEPT ![attempt] = commitVersion]
    /\ attemptCommitEpoch' =
           [attemptCommitEpoch EXCEPT ![attempt] = epoch]
    /\ attemptBaseVersion' =
           [attemptBaseVersion EXCEPT ![attempt] = durableVersion]
    /\ applyCount' = [applyCount EXCEPT ![op] = @ + 1]
    /\ activeAttempt' = NoAttempt
    /\ attemptState' =
           [attemptState EXCEPT
               ![attempt] =
                   IF @ = "Executing"
                   THEN "Committed"
                   ELSE "LostCommitted"]
    /\ UNCHANGED <<
           running, epoch, submittedOps, opEpoch, expectedVersion,
           attemptOp, ackedOps, ackVersion, readerState, readerRequired,
           readerObserved
       >>

ReturnExisting(attempt) ==
    LET op == attemptOp[attempt] IN
    /\ running
    /\ activeAttempt = attempt
    /\ attemptState[attempt] \in {"Executing", "AbandonedExecuting"}
    /\ opResult[op] # NoVersion
    /\ activeAttempt' = NoAttempt
    /\ attemptState' =
           [attemptState EXCEPT
               ![attempt] =
                   IF @ = "Executing"
                   THEN "Replayed"
                   ELSE "LostCommitted"]
    /\ UNCHANGED <<
           running, epoch, durableVersion, submittedOps, opEpoch,
           expectedVersion, attemptOp, opResult, opOutcome, committedAttempts,
           attemptVersion, attemptCommitEpoch, attemptBaseVersion,
           applyCount, ackedOps, ackVersion, readerState, readerRequired,
           readerObserved
       >>

CommitRejectedAttempt(attempt) ==
    LET op == attemptOp[attempt]
        commitVersion == NextCommitVersion
        outcome == IF ~EpochGuard(op)
                   THEN "StaleEpoch"
                   ELSE "ConditionFailed"
    IN
    /\ running
    /\ activeAttempt = attempt
    /\ attemptState[attempt] \in {"Executing", "AbandonedExecuting"}
    /\ opResult[op] = NoVersion
    /\ \/ ~EpochGuard(op)
       \/ ~ConditionalGuard(op)
    /\ commitVersion <= MaxCommits
    /\ durableVersion' = commitVersion
    /\ opResult' = [opResult EXCEPT ![op] = commitVersion]
    /\ opOutcome' = [opOutcome EXCEPT ![op] = outcome]
    /\ committedAttempts' = committedAttempts \cup {attempt}
    /\ attemptVersion' =
           [attemptVersion EXCEPT ![attempt] = commitVersion]
    /\ attemptCommitEpoch' =
           [attemptCommitEpoch EXCEPT ![attempt] = epoch]
    /\ attemptBaseVersion' =
           [attemptBaseVersion EXCEPT ![attempt] = durableVersion]
    /\ activeAttempt' = NoAttempt
    /\ attemptState' =
           [attemptState EXCEPT
               ![attempt] =
                   IF @ = "Executing"
                   THEN "Committed"
                   ELSE "LostCommitted"]
    /\ UNCHANGED <<
           running, epoch, submittedOps, opEpoch, expectedVersion,
           attemptOp, applyCount, ackedOps, ackVersion, readerState,
           readerRequired, readerObserved
       >>

Acknowledge(attempt) ==
    LET op == attemptOp[attempt] IN
    /\ running
    /\ attemptState[attempt] \in {"Committed", "Replayed"}
    /\ opResult[op] # NoVersion
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "Responded"]
    /\ ackedOps' = ackedOps \cup {op}
    /\ ackVersion' = [ackVersion EXCEPT ![op] = opResult[op]]
    /\ UNCHANGED <<
           running, epoch, durableVersion, submittedOps, opEpoch,
           expectedVersion, attemptOp, activeAttempt, opResult, opOutcome,
           committedAttempts, attemptVersion, attemptCommitEpoch,
           attemptBaseVersion, applyCount, readerState, readerRequired,
           readerObserved
       >>

AcknowledgeBeforeCommit(attempt) ==
    LET op == attemptOp[attempt] IN
    /\ Mutation = "AckBeforeCommit"
    /\ running
    /\ attemptState[attempt] \in {"Queued", "Executing"}
    /\ opResult[op] = NoVersion
    /\ ackedOps' = ackedOps \cup {op}
    /\ ackVersion' = [ackVersion EXCEPT ![op] = durableVersion + 1]
    /\ UNCHANGED <<
           running, epoch, durableVersion, submittedOps, opEpoch,
           expectedVersion, attemptState, attemptOp, activeAttempt,
           opResult, opOutcome, committedAttempts, attemptVersion,
           attemptCommitEpoch, attemptBaseVersion, applyCount,
           readerState, readerRequired, readerObserved
       >>

Reconcile(op) ==
    /\ running
    /\ op \in submittedOps
    /\ opResult[op] # NoVersion
    /\ op \notin ackedOps
    /\ ackedOps' = ackedOps \cup {op}
    /\ ackVersion' = [ackVersion EXCEPT ![op] = opResult[op]]
    /\ UNCHANGED <<
           running, epoch, durableVersion, submittedOps, opEpoch,
           expectedVersion, attemptState, attemptOp, activeAttempt,
           opResult, opOutcome, committedAttempts, attemptVersion,
           attemptCommitEpoch, attemptBaseVersion, applyCount,
           readerState, readerRequired, readerObserved
       >>

BeginRead(reader, observed) ==
    /\ running
    /\ readerState[reader] = "Idle"
    /\ observed \in 0..durableVersion
    /\ \/ observed = durableVersion
       \/ Mutation = "StaleRead"
    /\ readerState' = [readerState EXCEPT ![reader] = "Active"]
    /\ readerRequired' =
           [readerRequired EXCEPT ![reader] = LatestAckedVersion]
    /\ readerObserved' = [readerObserved EXCEPT ![reader] = observed]
    /\ UNCHANGED <<
           running, epoch, durableVersion, submittedOps, opEpoch,
           expectedVersion, attemptState, attemptOp, activeAttempt,
           opResult, opOutcome, committedAttempts, attemptVersion,
           attemptCommitEpoch, attemptBaseVersion, applyCount, ackedOps,
           ackVersion
       >>

FinishRead(reader) ==
    /\ running
    /\ readerState[reader] = "Active"
    /\ readerState' = [readerState EXCEPT ![reader] = "Completed"]
    /\ UNCHANGED <<
           running, epoch, durableVersion, submittedOps, opEpoch,
           expectedVersion, attemptState, attemptOp, activeAttempt,
           opResult, opOutcome, committedAttempts, attemptVersion,
           attemptCommitEpoch, attemptBaseVersion, applyCount, ackedOps,
           ackVersion, readerRequired, readerObserved
       >>

RotateEpoch ==
    /\ running
    /\ epoch < MaxEpoch
    /\ activeAttempt = NoAttempt
    /\ epoch' = epoch + 1
    /\ UNCHANGED <<
           running, durableVersion, submittedOps, opEpoch,
           expectedVersion, attemptState, attemptOp, activeAttempt,
           opResult, opOutcome, committedAttempts, attemptVersion,
           attemptCommitEpoch, attemptBaseVersion, applyCount, ackedOps,
           ackVersion, readerState, readerRequired, readerObserved
       >>

Crash ==
    /\ running
    /\ running' = FALSE
    /\ activeAttempt' = NoAttempt
    /\ attemptState' =
           [attempt \in Attempts |-> CrashAttemptState(attempt)]
    /\ readerState' =
           [reader \in Readers |-> CrashReaderState(reader)]
    /\ UNCHANGED <<
           epoch, durableVersion, submittedOps, opEpoch, expectedVersion,
           attemptOp, opResult, opOutcome, committedAttempts, attemptVersion,
           attemptCommitEpoch, attemptBaseVersion, applyCount, ackedOps,
           ackVersion, readerRequired, readerObserved
       >>

Recover ==
    /\ ~running
    /\ epoch < MaxEpoch
    /\ running' = TRUE
    /\ epoch' = epoch + 1
    /\ UNCHANGED <<
           durableVersion, submittedOps, opEpoch, expectedVersion,
           attemptState, attemptOp, activeAttempt, opResult, opOutcome,
           committedAttempts, attemptVersion, attemptCommitEpoch,
           attemptBaseVersion, applyCount, ackedOps, ackVersion,
           readerState, readerRequired, readerObserved
       >>

Next ==
    \/ \E op \in Operations : SubmitOp(op)
    \/ \E op \in Operations, attempt \in Attempts :
           QueueAttempt(op, attempt)
    \/ \E attempt \in Attempts : AbandonAttempt(attempt)
    \/ \E attempt \in Attempts : StartWriter(attempt)
    \/ \E attempt \in Attempts : CommitAttempt(attempt)
    \/ \E attempt \in Attempts : ReturnExisting(attempt)
    \/ \E attempt \in Attempts : CommitRejectedAttempt(attempt)
    \/ \E attempt \in Attempts : Acknowledge(attempt)
    \/ \E attempt \in Attempts : AcknowledgeBeforeCommit(attempt)
    \/ \E op \in Operations : Reconcile(op)
    \/ \E reader \in Readers, observed \in 0..MaxCommits :
           BeginRead(reader, observed)
    \/ \E reader \in Readers : FinishRead(reader)
    \/ RotateEpoch
    \/ Crash
    \/ Recover

Spec == Init /\ [][Next]_vars

=============================================================================
