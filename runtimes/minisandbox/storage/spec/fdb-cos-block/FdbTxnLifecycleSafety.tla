---------------------- MODULE FdbTxnLifecycleSafety ----------------------
EXTENDS FdbTxnLifecycle

AttemptTypeOK(attempt) ==
    /\ attemptState[attempt] \in AttemptStates
    /\ IF attemptState[attempt] = "Free"
       THEN attemptOp[attempt] = NoOp
       ELSE attemptOp[attempt] \in submittedOps

TypeOK ==
    /\ epoch \in 1..MaxEpoch
    /\ currentWriter \in Writers
    /\ nextSeq \in 1..(MaxSeq + 1)
    /\ retiredEpoch \in 0..MaxEpoch
    /\ retiredEpoch < epoch
    /\ submittedOps \subseteq OpIds
    /\ opEpoch \in [OpIds -> 0..MaxEpoch]
    /\ opSeq \in [OpIds -> 0..MaxSeq]
    /\ opWriter \in [OpIds -> Writers \cup {NoWriter}]
    /\ \A attempt \in Attempts : AttemptTypeOK(attempt)
    /\ opResult \in [OpIds -> Versions]
    /\ committedOps \subseteq submittedOps
    /\ committedVersions \subseteq Versions \ {NoVersion}
    /\ ackedOps \subseteq submittedOps
    /\ retryClosed \subseteq ackedOps
    /\ applyCount \in [OpIds -> 0..Cardinality(Attempts)]
    /\ headVersion \in Versions
    /\ staleMutation \in BOOLEAN
    /\ duplicateApply \in BOOLEAN
    /\ unknownLateApply \in BOOLEAN
    /\ unsafeGc \in BOOLEAN

SubmittedMetadataValid ==
    /\ \A op \in submittedOps :
           /\ opEpoch[op] \in 1..MaxEpoch
           /\ opSeq[op] \in 1..MaxSeq
           /\ opWriter[op] \in Writers
    /\ \A op \in OpIds \ submittedOps :
           /\ opEpoch[op] = 0
           /\ opSeq[op] = 0
           /\ opWriter[op] = NoWriter

VersionIdentityUnique ==
    \A left \in submittedOps, right \in submittedOps :
        OpVersion(left) = OpVersion(right) => left = right

CommittedHistoryExact ==
    /\ committedOps = {op \in submittedOps : applyCount[op] > 0}
    /\ committedVersions = {OpVersion(op) : op \in committedOps}
    /\ \A op \in submittedOps :
           opResult[op] # NoVersion => opResult[op] = OpVersion(op)

OperationsApplyAtMostOnce ==
    /\ ~duplicateApply
    /\ \A op \in submittedOps : applyCount[op] <= 1

AcknowledgementsAreDurable ==
    \A op \in ackedOps :
        /\ op \in committedOps
        /\ applyCount[op] = 1

HeadCoversCommittedVersions ==
    /\ IF committedVersions = {}
       THEN headVersion = NoVersion
       ELSE headVersion \in committedVersions
    /\ \A version \in committedVersions : VersionLE(version, headVersion)

StaleEpochsAreFenced == ~staleMutation

CommitUnknownIsTerminal == ~unknownLateApply

ResultsRetainedUntilSafe ==
    \A op \in committedOps :
        ~ResultGcSafe(op) => opResult[op] # NoVersion

NoEarlyResultGc == ~unsafeGc

Safety ==
    /\ TypeOK
    /\ SubmittedMetadataValid
    /\ VersionIdentityUnique
    /\ CommittedHistoryExact
    /\ OperationsApplyAtMostOnce
    /\ AcknowledgementsAreDurable
    /\ HeadCoversCommittedVersions
    /\ StaleEpochsAreFenced
    /\ CommitUnknownIsTerminal
    /\ ResultsRetainedUntilSafe
    /\ NoEarlyResultGc

=============================================================================
