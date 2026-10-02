---------------------- MODULE SqliteMetaStoreSafety ----------------------
EXTENDS SqliteMetaStore

AttemptTypeOK(attempt) ==
    /\ attemptState[attempt] \in AttemptStates
    /\ IF attemptState[attempt] = "Free"
       THEN attemptOp[attempt] = NoOp
       ELSE attemptOp[attempt] \in submittedOps

ReaderTypeOK(reader) ==
    /\ readerState[reader] \in ReaderStates
    /\ readerRequired[reader] \in 0..MaxCommits
    /\ readerObserved[reader] \in 0..MaxCommits

TypeOK ==
    /\ running \in BOOLEAN
    /\ epoch \in 1..MaxEpoch
    /\ durableVersion \in 0..MaxCommits
    /\ submittedOps \subseteq Operations
    /\ opEpoch \in [Operations -> 0..MaxEpoch]
    /\ expectedVersion \in [Operations -> 0..MaxCommits]
    /\ \A attempt \in Attempts : AttemptTypeOK(attempt)
    /\ activeAttempt \in Attempts \cup {NoAttempt}
    /\ opResult \in [Operations -> 0..MaxCommits]
    /\ opOutcome \in [Operations -> Outcomes]
    /\ committedAttempts \subseteq Attempts
    /\ attemptVersion \in [Attempts -> 0..MaxCommits]
    /\ attemptCommitEpoch \in [Attempts -> 0..MaxEpoch]
    /\ attemptBaseVersion \in [Attempts -> 0..MaxCommits]
    /\ applyCount \in [Operations -> 0..Cardinality(Attempts)]
    /\ ackedOps \subseteq submittedOps
    /\ ackVersion \in [Operations -> 0..MaxCommits]
    /\ \A reader \in Readers : ReaderTypeOK(reader)

SubmittedMetadataValid ==
    /\ \A op \in submittedOps : opEpoch[op] \in 1..MaxEpoch
    /\ \A op \in Operations \ submittedOps :
           /\ opEpoch[op] = 0
           /\ expectedVersion[op] = NoVersion

SingleWriterLinearization ==
    /\ activeAttempt = NoAttempt
       \/ /\ activeAttempt \in Attempts
          /\ attemptState[activeAttempt] \in {
                 "Executing",
                 "AbandonedExecuting"
             }
    /\ \A attempt \in Attempts :
           attemptState[attempt] \in {
               "Executing",
               "AbandonedExecuting"
           } => attempt = activeAttempt

CommittedMetadataExact ==
    /\ committedAttempts = {
           attempt \in Attempts : attemptVersion[attempt] # NoVersion
       }
    /\ \A attempt \in committedAttempts :
           /\ attemptOp[attempt] \in submittedOps
           /\ attemptCommitEpoch[attempt] \in 1..MaxEpoch
           /\ attemptBaseVersion[attempt] < attemptVersion[attempt]
    /\ \A op \in submittedOps :
           opResult[op] # NoVersion =>
               \E attempt \in committedAttempts :
                   /\ attemptOp[attempt] = op
                   /\ attemptVersion[attempt] = opResult[op]

DurableOutcomesExact ==
    /\ \A op \in Operations :
           (opResult[op] = NoVersion) = (opOutcome[op] = NoOutcome)
    /\ \A op \in Operations :
           opOutcome[op] \in {"ConditionFailed", "StaleEpoch"} =>
               applyCount[op] = 0

CommitVersionsLinear ==
    LET versions == {
            attemptVersion[attempt] : attempt \in committedAttempts
        }
    IN
    /\ Cardinality(versions) = Cardinality(committedAttempts)
    /\ versions = 1..durableVersion

OperationsApplyAtMostOnce ==
    \A op \in Operations : applyCount[op] <= 1

AcknowledgementsAreDurable ==
    \A op \in ackedOps :
        /\ opResult[op] # NoVersion
        /\ ackVersion[op] = opResult[op]
        /\ \E attempt \in committedAttempts :
               /\ attemptOp[attempt] = op
               /\ attemptVersion[attempt] = ackVersion[op]

StaleEpochsAreFenced ==
    \A attempt \in committedAttempts :
        opOutcome[attemptOp[attempt]] = "Applied" =>
            opEpoch[attemptOp[attempt]] = attemptCommitEpoch[attempt]

ConditionalWritesAreAtomic ==
    \A attempt \in committedAttempts :
        ( /\ opOutcome[attemptOp[attempt]] = "Applied"
          /\ attemptOp[attempt] \in CasOperations ) =>
            expectedVersion[attemptOp[attempt]] =
                attemptBaseVersion[attempt]

ReadsRespectRealTime ==
    \A reader \in Readers :
        readerState[reader] = "Completed" =>
            readerObserved[reader] >= readerRequired[reader]

Safety ==
    /\ TypeOK
    /\ SubmittedMetadataValid
    /\ SingleWriterLinearization
    /\ CommittedMetadataExact
    /\ DurableOutcomesExact
    /\ CommitVersionsLinear
    /\ OperationsApplyAtMostOnce
    /\ AcknowledgementsAreDurable
    /\ StaleEpochsAreFenced
    /\ ConditionalWritesAreAtomic
    /\ ReadsRespectRealTime

=============================================================================
