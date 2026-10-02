------------------- MODULE VolumeTxnLifecycleSafety -------------------
EXTENDS VolumeTxnLifecycle

AttemptTypeOK(attempt) ==
    /\ attemptState[attempt] \in AttemptStates
    /\ IF attemptState[attempt] = "Free"
       THEN attemptOp[attempt] = NoOp
       ELSE attemptOp[attempt] \in submittedOps

InstanceTypeOK(instance) ==
    /\ volumeState[instance] \in VolumeStates
    /\ epoch[instance] \in 0..MaxEpoch
    /\ retiredFromEpoch[instance] \in 0..MaxEpoch
    /\ closedRetryEpoch[instance] \in 0..MaxEpoch
    /\ acceptingSubmissions[instance] \in BOOLEAN
    /\ rootLive[instance] \in BOOLEAN
    /\ gcOutbox[instance] \in OutboxStates
    /\ rootReleaseCount[instance] \in 0..2
    /\ retiredAt[instance] \in 0..MaxCommitVersion

TypeOK ==
    /\ volumeState \in [Instances -> VolumeStates]
    /\ currentIncarnation \in
           [VolumeIds -> Incarnations \cup {NoIncarnation}]
    /\ epoch \in [Instances -> 0..MaxEpoch]
    /\ retiredFromEpoch \in [Instances -> 0..MaxEpoch]
    /\ closedRetryEpoch \in [Instances -> 0..MaxEpoch]
    /\ acceptingSubmissions \in [Instances -> BOOLEAN]
    /\ rootLive \in [Instances -> BOOLEAN]
    /\ gcOutbox \in [Instances -> OutboxStates]
    /\ everRetired \subseteq Instances
    /\ rootReleaseCount \in [Instances -> 0..2]
    /\ retiredAt \in [Instances -> 0..MaxCommitVersion]
    /\ \A instance \in Instances : InstanceTypeOK(instance)
    /\ submittedOps \subseteq OpIds
    /\ opVolume \in [OpIds -> Instances \cup {NoInstance}]
    /\ opEpoch \in [OpIds -> 0..MaxEpoch]
    /\ \A attempt \in Attempts : AttemptTypeOK(attempt)
    /\ opResult \in [OpIds -> ResultStates]
    /\ committedOps \subseteq submittedOps
    /\ ackedOps \subseteq submittedOps
    /\ retryClosedOps \subseteq submittedOps
    /\ resultGcOps \subseteq committedOps
    /\ applyCount \in [OpIds -> 0..Cardinality(Attempts)]
    /\ opCommittedAt \in [OpIds -> 0..MaxCommitVersion]
    /\ headOp \in [Instances -> OpIds \cup {NoOp}]
    /\ submittedDeletes \subseteq DeleteIds
    /\ deleteVolume \in [DeleteIds -> Instances \cup {NoInstance}]
    /\ deleteResult \in [DeleteIds -> BOOLEAN]
    /\ deleteAcked \subseteq submittedDeletes
    /\ deleteApplyCount \in [DeleteIds -> 0..1]
    /\ commitVersion \in 0..MaxCommitVersion

CurrentIncarnationExact ==
    \A id \in VolumeIds :
        LET active ==
            {instance \in Instances :
                /\ instance.id = id
                /\ volumeState[instance] = "Active"}
        IN
        \/ /\ active = {}
           /\ currentIncarnation[id] = NoIncarnation
        \/ /\ Cardinality(active) = 1
           /\ currentIncarnation[id] \in
                  {instance.incarnation : instance \in active}

UnusedInstancesArePristine ==
    \A instance \in Instances :
        volumeState[instance] = "Unused" =>
            /\ epoch[instance] = 0
            /\ retiredFromEpoch[instance] = 0
            /\ closedRetryEpoch[instance] = 0
            /\ ~acceptingSubmissions[instance]
            /\ ~rootLive[instance]
            /\ gcOutbox[instance] = "None"
            /\ rootReleaseCount[instance] = 0
            /\ retiredAt[instance] = 0

ActiveInstancesAreOpen ==
    \A instance \in Instances :
        volumeState[instance] = "Active" =>
            /\ epoch[instance] \in 1..MaxEpoch
            /\ closedRetryEpoch[instance] < epoch[instance]
            /\ rootLive[instance]
            /\ gcOutbox[instance] = "None"
            /\ rootReleaseCount[instance] = 0
            /\ retiredAt[instance] = 0

DeleteFenceAndRootReleaseAreAtomic ==
    \A instance \in Instances :
        volumeState[instance] = "Retired" =>
            /\ instance \in everRetired
            /\ retiredFromEpoch[instance] \in 1..(MaxEpoch - 1)
            /\ epoch[instance] = retiredFromEpoch[instance] + 1
            /\ closedRetryEpoch[instance] = retiredFromEpoch[instance]
            /\ ~acceptingSubmissions[instance]
            /\ ~rootLive[instance]
            /\ gcOutbox[instance] = "Pending"
            /\ rootReleaseCount[instance] = 1
            /\ retiredAt[instance] > 0

RetiredIncarnationsNeverReactivate ==
    \A instance \in everRetired : volumeState[instance] = "Retired"

SubmittedMetadataValid ==
    /\ \A op \in submittedOps :
           /\ opVolume[op] \in Instances
           /\ opEpoch[op] \in 1..MaxEpoch
    /\ \A op \in OpIds \ submittedOps :
           /\ opVolume[op] = NoInstance
           /\ opEpoch[op] = 0
    /\ \A delete \in submittedDeletes : deleteVolume[delete] \in Instances
    /\ \A delete \in DeleteIds \ submittedDeletes :
           deleteVolume[delete] = NoInstance

OperationsApplyAtMostOnce ==
    \A op \in OpIds : applyCount[op] <= 1

CommittedHistoryExact ==
    /\ committedOps = {op \in submittedOps : applyCount[op] = 1}
    /\ \A op \in committedOps : opCommittedAt[op] > 0
    /\ \A op \in submittedOps \ committedOps : opCommittedAt[op] = 0

AcknowledgementsAreDurable ==
    \A op \in ackedOps :
        /\ op \in committedOps
        /\ applyCount[op] = 1

LateCommitsAreFenced ==
    \A op \in committedOps :
        LET instance == opVolume[op] IN
        instance \in everRetired => opCommittedAt[op] < retiredAt[instance]

RetryClosureRequiresFence ==
    \A instance \in Instances :
        closedRetryEpoch[instance] > 0 =>
            closedRetryEpoch[instance] < epoch[instance]

ResultsRetainedWhileRetryable ==
    \A op \in committedOps :
        ~ResultGcSafe(op) => opResult[op] = "Applied"

ResultGcRequiresClosedWindow ==
    \A op \in resultGcOps : ResultGcSafe(op)

DeleteTransactionsApplyOnce ==
    \A delete \in DeleteIds : deleteApplyCount[delete] <= 1

DeleteResultsMatchAtomicCommit ==
    \A delete \in submittedDeletes :
        /\ (deleteResult[delete] <=> deleteApplyCount[delete] = 1)
        /\ (deleteResult[delete] =>
               volumeState[deleteVolume[delete]] = "Retired")

DeleteAcknowledgementsAreDurable ==
    \A delete \in deleteAcked : deleteResult[delete]

Safety ==
    /\ TypeOK
    /\ CurrentIncarnationExact
    /\ UnusedInstancesArePristine
    /\ ActiveInstancesAreOpen
    /\ DeleteFenceAndRootReleaseAreAtomic
    /\ RetiredIncarnationsNeverReactivate
    /\ SubmittedMetadataValid
    /\ OperationsApplyAtMostOnce
    /\ CommittedHistoryExact
    /\ AcknowledgementsAreDurable
    /\ LateCommitsAreFenced
    /\ RetryClosureRequiresFence
    /\ ResultsRetainedWhileRetryable
    /\ ResultGcRequiresClosedWindow
    /\ DeleteTransactionsApplyOnce
    /\ DeleteResultsMatchAtomicCommit
    /\ DeleteAcknowledgementsAreDurable

=============================================================================
