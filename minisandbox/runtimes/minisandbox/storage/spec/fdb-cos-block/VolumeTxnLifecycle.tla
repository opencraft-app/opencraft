---------------------- MODULE VolumeTxnLifecycle ----------------------
EXTENDS Naturals, FiniteSets

CONSTANTS VolumeIds, Incarnations, OpIds, Attempts, DeleteIds, MaxEpoch,
          Mutation

NoVolumeId == "NoVolumeId"
NoIncarnation == "NoIncarnation"
NoOp == "NoOp"
NoDelete == "NoDelete"

Instance(id, incarnation) == [id |-> id, incarnation |-> incarnation]

Instances ==
    {Instance(id, incarnation) :
        id \in VolumeIds, incarnation \in Incarnations}

NoInstance == Instance(NoVolumeId, NoIncarnation)

VolumeStates == {"Unused", "Active", "Retired"}
AttemptStates == {
    "Free",
    "Sent",
    "AmbiguousInFlight",
    "KnownCommitted",
    "UnknownTerminal",
    "LateTerminal",
    "Aborted"
}
ResultStates == {"NoResult", "Applied"}
OutboxStates == {"None", "Pending"}

ASSUME /\ VolumeIds # {}
       /\ Incarnations # {}
       /\ OpIds # {}
       /\ Attempts # {}
       /\ DeleteIds # {}
       /\ MaxEpoch \in Nat \ {0}
       /\ NoVolumeId \notin VolumeIds
       /\ NoIncarnation \notin Incarnations
       /\ NoOp \notin OpIds
       /\ NoDelete \notin DeleteIds
       /\ Mutation \in {
            "None",
            "MissingVolumeConflict",
            "MissingOpConflict",
            "DeleteNoEpochAdvance",
            "DeleteOutboxNotAtomic",
            "DeleteReplyBeforeCommit",
            "DeleteDoubleRelease",
            "RetryCloseBeforeFence",
            "ReuseRetiredIncarnation",
            "GcResultBeforeFence"
          }

InitialVolumeId == CHOOSE id \in VolumeIds : TRUE
InitialIncarnation == CHOOSE incarnation \in Incarnations : TRUE
InitialInstance == Instance(InitialVolumeId, InitialIncarnation)

MaxCommitVersion ==
    Cardinality(Attempts) + Cardinality(DeleteIds) + Cardinality(Instances)

VARIABLES
    volumeState,
    currentIncarnation,
    epoch,
    retiredFromEpoch,
    closedRetryEpoch,
    acceptingSubmissions,
    rootLive,
    gcOutbox,
    everRetired,
    rootReleaseCount,
    retiredAt,
    submittedOps,
    opVolume,
    opEpoch,
    attemptState,
    attemptOp,
    opResult,
    committedOps,
    ackedOps,
    retryClosedOps,
    resultGcOps,
    applyCount,
    opCommittedAt,
    headOp,
    submittedDeletes,
    deleteVolume,
    deleteResult,
    deleteAcked,
    deleteApplyCount,
    commitVersion

vars == <<
    volumeState,
    currentIncarnation,
    epoch,
    retiredFromEpoch,
    closedRetryEpoch,
    acceptingSubmissions,
    rootLive,
    gcOutbox,
    everRetired,
    rootReleaseCount,
    retiredAt,
    submittedOps,
    opVolume,
    opEpoch,
    attemptState,
    attemptOp,
    opResult,
    committedOps,
    ackedOps,
    retryClosedOps,
    resultGcOps,
    applyCount,
    opCommittedAt,
    headOp,
    submittedDeletes,
    deleteVolume,
    deleteResult,
    deleteAcked,
    deleteApplyCount,
    commitVersion
>>

IsCurrent(instance) ==
    currentIncarnation[instance.id] = instance.incarnation

VolumeFenceValid(op) ==
    LET instance == opVolume[op] IN
    /\ instance \in Instances
    /\ volumeState[instance] = "Active"
    /\ IsCurrent(instance)
    /\ opEpoch[op] = epoch[instance]

OpResultGuard(op) ==
    \/ opResult[op] = "NoResult"
    \/ Mutation = "MissingOpConflict"

CanCommit(attempt) ==
    LET op == attemptOp[attempt] IN
    /\ op \in submittedOps
    /\ (VolumeFenceValid(op) \/ Mutation = "MissingVolumeConflict")
    /\ OpResultGuard(op)

AttemptsInFlightFor(op) ==
    {attempt \in Attempts :
        /\ attemptOp[attempt] = op
        /\ attemptState[attempt] \in {"Sent", "AmbiguousInFlight"}}

AllAttemptsTerminal(op) == AttemptsInFlightFor(op) = {}

RetryWindowOpen(op) ==
    IF op \in submittedOps
    THEN opEpoch[op] > closedRetryEpoch[opVolume[op]]
    ELSE FALSE

ResultGcSafe(op) ==
    LET instance == opVolume[op] IN
    \/ /\ op \in retryClosedOps
       /\ opEpoch[op] < epoch[instance]
    \/ /\ volumeState[instance] = "Retired"
       /\ opEpoch[op] <= closedRetryEpoch[instance]

Init ==
    /\ volumeState =
           [instance \in Instances |->
               IF instance = InitialInstance THEN "Active" ELSE "Unused"]
    /\ currentIncarnation =
           [id \in VolumeIds |->
               IF id = InitialVolumeId
               THEN InitialIncarnation
               ELSE NoIncarnation]
    /\ epoch =
           [instance \in Instances |->
               IF instance = InitialInstance THEN 1 ELSE 0]
    /\ retiredFromEpoch = [instance \in Instances |-> 0]
    /\ closedRetryEpoch = [instance \in Instances |-> 0]
    /\ acceptingSubmissions =
           [instance \in Instances |-> instance = InitialInstance]
    /\ rootLive = [instance \in Instances |-> instance = InitialInstance]
    /\ gcOutbox = [instance \in Instances |-> "None"]
    /\ everRetired = {}
    /\ rootReleaseCount = [instance \in Instances |-> 0]
    /\ retiredAt = [instance \in Instances |-> 0]
    /\ submittedOps = {}
    /\ opVolume = [op \in OpIds |-> NoInstance]
    /\ opEpoch = [op \in OpIds |-> 0]
    /\ attemptState = [attempt \in Attempts |-> "Free"]
    /\ attemptOp = [attempt \in Attempts |-> NoOp]
    /\ opResult = [op \in OpIds |-> "NoResult"]
    /\ committedOps = {}
    /\ ackedOps = {}
    /\ retryClosedOps = {}
    /\ resultGcOps = {}
    /\ applyCount = [op \in OpIds |-> 0]
    /\ opCommittedAt = [op \in OpIds |-> 0]
    /\ headOp = [instance \in Instances |-> NoOp]
    /\ submittedDeletes = {}
    /\ deleteVolume = [delete \in DeleteIds |-> NoInstance]
    /\ deleteResult = [delete \in DeleteIds |-> FALSE]
    /\ deleteAcked = {}
    /\ deleteApplyCount = [delete \in DeleteIds |-> 0]
    /\ commitVersion = 0

SubmitWrite(instance, op) ==
    /\ instance \in Instances
    /\ volumeState[instance] = "Active"
    /\ IsCurrent(instance)
    /\ acceptingSubmissions[instance]
    /\ op \notin submittedOps
    /\ submittedOps' = submittedOps \cup {op}
    /\ opVolume' = [opVolume EXCEPT ![op] = instance]
    /\ opEpoch' = [opEpoch EXCEPT ![op] = epoch[instance]]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, attemptState, attemptOp,
           opResult, committedOps, ackedOps, retryClosedOps, resultGcOps,
           applyCount, opCommittedAt, headOp, submittedDeletes, deleteVolume,
           deleteResult, deleteAcked, deleteApplyCount, commitVersion
       >>

StartAttempt(op, attempt) ==
    /\ op \in submittedOps
    /\ op \notin ackedOps
    /\ op \notin retryClosedOps
    /\ RetryWindowOpen(op)
    /\ opResult[op] = "NoResult"
    /\ attemptState[attempt] = "Free"
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "Sent"]
    /\ attemptOp' = [attemptOp EXCEPT ![attempt] = op]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, opResult, committedOps, ackedOps, retryClosedOps,
           resultGcOps, applyCount, opCommittedAt, headOp, submittedDeletes,
           deleteVolume, deleteResult, deleteAcked, deleteApplyCount,
           commitVersion
       >>

ApplyWrite(attempt) ==
    LET op == attemptOp[attempt]
        instance == opVolume[op]
    IN
    /\ opResult' = [opResult EXCEPT ![op] = "Applied"]
    /\ committedOps' = committedOps \cup {op}
    /\ applyCount' = [applyCount EXCEPT ![op] = @ + 1]
    /\ opCommittedAt' = [opCommittedAt EXCEPT ![op] = commitVersion + 1]
    /\ headOp' = [headOp EXCEPT ![instance] = op]
    /\ commitVersion' = commitVersion + 1

CommitKnown(attempt) ==
    LET op == attemptOp[attempt] IN
    /\ attemptState[attempt] = "Sent"
    /\ CanCommit(attempt)
    /\ ApplyWrite(attempt)
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "KnownCommitted"]
    /\ ackedOps' = ackedOps \cup {op}
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptOp, retryClosedOps, resultGcOps, submittedDeletes,
           deleteVolume, deleteResult, deleteAcked, deleteApplyCount
       >>

CommitUnknownApplied(attempt) ==
    /\ attemptState[attempt] = "Sent"
    /\ CanCommit(attempt)
    /\ ApplyWrite(attempt)
    /\ attemptState' =
           [attemptState EXCEPT ![attempt] = "UnknownTerminal"]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptOp, ackedOps, retryClosedOps, resultGcOps,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount
       >>

CommitUnknownNotApplied(attempt) ==
    /\ attemptState[attempt] = "Sent"
    /\ attemptState' =
           [attemptState EXCEPT ![attempt] = "UnknownTerminal"]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

TimeoutOrCancel(attempt) ==
    /\ attemptState[attempt] = "Sent"
    /\ attemptState' =
           [attemptState EXCEPT ![attempt] = "AmbiguousInFlight"]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

AbortKnown(attempt) ==
    /\ attemptState[attempt] = "Sent"
    /\ ~CanCommit(attempt)
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "Aborted"]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

LateCommit(attempt) ==
    /\ attemptState[attempt] = "AmbiguousInFlight"
    /\ CanCommit(attempt)
    /\ ApplyWrite(attempt)
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "LateTerminal"]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptOp, ackedOps, retryClosedOps, resultGcOps,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount
       >>

LateAbort(attempt) ==
    /\ attemptState[attempt] = "AmbiguousInFlight"
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "Aborted"]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

ReconcileCommitted(op) ==
    /\ op \in submittedOps
    /\ opResult[op] = "Applied"
    /\ op \notin ackedOps
    /\ RetryWindowOpen(op)
    /\ ackedOps' = ackedOps \cup {op}
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptState, attemptOp, opResult, committedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

CloseOpRetry(op) ==
    /\ op \in ackedOps
    /\ op \notin retryClosedOps
    /\ AllAttemptsTerminal(op)
    /\ retryClosedOps' = retryClosedOps \cup {op}
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptState, attemptOp, opResult, committedOps, ackedOps,
           resultGcOps, applyCount, opCommittedAt, headOp, submittedDeletes,
           deleteVolume, deleteResult, deleteAcked, deleteApplyCount,
           commitVersion
       >>

GcResult(op) ==
    /\ op \in committedOps
    /\ opResult[op] = "Applied"
    /\ \/ ResultGcSafe(op)
       \/ Mutation = "GcResultBeforeFence"
    /\ opResult' = [opResult EXCEPT ![op] = "NoResult"]
    /\ resultGcOps' = resultGcOps \cup {op}
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptState, attemptOp, committedOps, ackedOps,
           retryClosedOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

StopSubmissions(instance) ==
    /\ volumeState[instance] = "Active"
    /\ acceptingSubmissions[instance]
    /\ acceptingSubmissions' =
           [acceptingSubmissions EXCEPT ![instance] = FALSE]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, rootLive, gcOutbox, everRetired,
           rootReleaseCount, retiredAt, submittedOps, opVolume, opEpoch,
           attemptState, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

SubmitDelete(instance, delete) ==
    /\ volumeState[instance] = "Active"
    /\ IsCurrent(instance)
    /\ ~acceptingSubmissions[instance]
    /\ delete \notin submittedDeletes
    /\ submittedDeletes' = submittedDeletes \cup {delete}
    /\ deleteVolume' = [deleteVolume EXCEPT ![delete] = instance]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptState, attemptOp, opResult, committedOps,
           ackedOps, retryClosedOps, resultGcOps, applyCount, opCommittedAt,
           headOp, deleteResult, deleteAcked, deleteApplyCount, commitVersion
       >>

ApplyDelete(delete) ==
    LET instance == deleteVolume[delete]
        oldEpoch == epoch[instance]
    IN
    /\ volumeState[instance] = "Active"
    /\ IsCurrent(instance)
    /\ ~acceptingSubmissions[instance]
    /\ deleteResult[delete] = FALSE
    /\ deleteApplyCount[delete] = 0
    /\ oldEpoch < MaxEpoch
    /\ volumeState' = [volumeState EXCEPT ![instance] = "Retired"]
    /\ currentIncarnation' =
           [currentIncarnation EXCEPT ![instance.id] = NoIncarnation]
    /\ epoch' =
           IF Mutation = "DeleteNoEpochAdvance"
           THEN epoch
           ELSE [epoch EXCEPT ![instance] = oldEpoch + 1]
    /\ retiredFromEpoch' =
           [retiredFromEpoch EXCEPT ![instance] = oldEpoch]
    /\ closedRetryEpoch' =
           [closedRetryEpoch EXCEPT ![instance] = oldEpoch]
    /\ rootLive' = [rootLive EXCEPT ![instance] = FALSE]
    /\ gcOutbox' =
           IF Mutation = "DeleteOutboxNotAtomic"
           THEN gcOutbox
           ELSE [gcOutbox EXCEPT ![instance] = "Pending"]
    /\ everRetired' = everRetired \cup {instance}
    /\ rootReleaseCount' =
           [rootReleaseCount EXCEPT ![instance] = @ + 1]
    /\ retiredAt' = [retiredAt EXCEPT ![instance] = commitVersion + 1]
    /\ deleteResult' = [deleteResult EXCEPT ![delete] = TRUE]
    /\ deleteApplyCount' = [deleteApplyCount EXCEPT ![delete] = @ + 1]
    /\ commitVersion' = commitVersion + 1

CommitDeleteKnown(delete) ==
    /\ delete \in submittedDeletes
    /\ ApplyDelete(delete)
    /\ deleteAcked' = deleteAcked \cup {delete}
    /\ UNCHANGED <<
           acceptingSubmissions, submittedOps, opVolume, opEpoch,
           attemptState, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume
       >>

CommitDeleteUnknown(delete) ==
    /\ delete \in submittedDeletes
    /\ ApplyDelete(delete)
    /\ UNCHANGED <<
           acceptingSubmissions, submittedOps, opVolume, opEpoch,
           attemptState, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteAcked
       >>

ReconcileDelete(delete) ==
    /\ delete \in submittedDeletes
    /\ deleteResult[delete]
    /\ delete \notin deleteAcked
    /\ deleteAcked' = deleteAcked \cup {delete}
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptState, attemptOp, opResult, committedOps,
           ackedOps, retryClosedOps, resultGcOps, applyCount, opCommittedAt,
           headOp, submittedDeletes, deleteVolume, deleteResult,
           deleteApplyCount, commitVersion
       >>

ReplyDeleteBeforeCommit(delete) ==
    /\ Mutation = "DeleteReplyBeforeCommit"
    /\ delete \in submittedDeletes
    /\ ~deleteResult[delete]
    /\ delete \notin deleteAcked
    /\ deleteAcked' = deleteAcked \cup {delete}
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, rootReleaseCount, retiredAt, submittedOps, opVolume,
           opEpoch, attemptState, attemptOp, opResult, committedOps,
           ackedOps, retryClosedOps, resultGcOps, applyCount, opCommittedAt,
           headOp, submittedDeletes, deleteVolume, deleteResult,
           deleteApplyCount, commitVersion
       >>

RetryDeleteDoubleRelease(delete) ==
    LET instance == deleteVolume[delete] IN
    /\ Mutation = "DeleteDoubleRelease"
    /\ deleteResult[delete]
    /\ rootReleaseCount[instance] = 1
    /\ rootReleaseCount' =
           [rootReleaseCount EXCEPT ![instance] = @ + 1]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           closedRetryEpoch, acceptingSubmissions, rootLive, gcOutbox,
           everRetired, retiredAt, submittedOps, opVolume, opEpoch,
           attemptState, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

CloseRetryBeforeFence(instance) ==
    /\ Mutation = "RetryCloseBeforeFence"
    /\ volumeState[instance] = "Active"
    /\ closedRetryEpoch[instance] < epoch[instance]
    /\ closedRetryEpoch' =
           [closedRetryEpoch EXCEPT ![instance] = epoch[instance]]
    /\ UNCHANGED <<
           volumeState, currentIncarnation, epoch, retiredFromEpoch,
           acceptingSubmissions, rootLive, gcOutbox, everRetired,
           rootReleaseCount, retiredAt, submittedOps, opVolume, opEpoch,
           attemptState, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

CreateNextIncarnation(id, incarnation) ==
    LET instance == Instance(id, incarnation) IN
    /\ currentIncarnation[id] = NoIncarnation
    /\ volumeState[instance] = "Unused"
    /\ volumeState' = [volumeState EXCEPT ![instance] = "Active"]
    /\ currentIncarnation' = [currentIncarnation EXCEPT ![id] = incarnation]
    /\ epoch' = [epoch EXCEPT ![instance] = 1]
    /\ acceptingSubmissions' =
           [acceptingSubmissions EXCEPT ![instance] = TRUE]
    /\ rootLive' = [rootLive EXCEPT ![instance] = TRUE]
    /\ UNCHANGED <<
           retiredFromEpoch, closedRetryEpoch, gcOutbox, everRetired,
           rootReleaseCount, retiredAt, submittedOps, opVolume, opEpoch,
           attemptState, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

ReuseRetiredIncarnation(instance) ==
    /\ Mutation = "ReuseRetiredIncarnation"
    /\ volumeState[instance] = "Retired"
    /\ currentIncarnation[instance.id] = NoIncarnation
    /\ volumeState' = [volumeState EXCEPT ![instance] = "Active"]
    /\ currentIncarnation' =
           [currentIncarnation EXCEPT ![instance.id] = instance.incarnation]
    /\ acceptingSubmissions' =
           [acceptingSubmissions EXCEPT ![instance] = TRUE]
    /\ rootLive' = [rootLive EXCEPT ![instance] = TRUE]
    /\ UNCHANGED <<
           epoch, retiredFromEpoch, closedRetryEpoch, gcOutbox, everRetired,
           rootReleaseCount, retiredAt, submittedOps, opVolume, opEpoch,
           attemptState, attemptOp, opResult, committedOps, ackedOps,
           retryClosedOps, resultGcOps, applyCount, opCommittedAt, headOp,
           submittedDeletes, deleteVolume, deleteResult, deleteAcked,
           deleteApplyCount, commitVersion
       >>

Next ==
    \/ \E instance \in Instances, op \in OpIds : SubmitWrite(instance, op)
    \/ \E op \in OpIds, attempt \in Attempts : StartAttempt(op, attempt)
    \/ \E attempt \in Attempts : CommitKnown(attempt)
    \/ \E attempt \in Attempts : CommitUnknownApplied(attempt)
    \/ \E attempt \in Attempts : CommitUnknownNotApplied(attempt)
    \/ \E attempt \in Attempts : TimeoutOrCancel(attempt)
    \/ \E attempt \in Attempts : AbortKnown(attempt)
    \/ \E attempt \in Attempts : LateCommit(attempt)
    \/ \E attempt \in Attempts : LateAbort(attempt)
    \/ \E op \in OpIds : ReconcileCommitted(op)
    \/ \E op \in OpIds : CloseOpRetry(op)
    \/ \E op \in OpIds : GcResult(op)
    \/ \E instance \in Instances : StopSubmissions(instance)
    \/ \E instance \in Instances, delete \in DeleteIds :
          SubmitDelete(instance, delete)
    \/ \E delete \in DeleteIds : CommitDeleteKnown(delete)
    \/ \E delete \in DeleteIds : CommitDeleteUnknown(delete)
    \/ \E delete \in DeleteIds : ReconcileDelete(delete)
    \/ \E delete \in DeleteIds : ReplyDeleteBeforeCommit(delete)
    \/ \E delete \in DeleteIds : RetryDeleteDoubleRelease(delete)
    \/ \E instance \in Instances : CloseRetryBeforeFence(instance)
    \/ \E id \in VolumeIds, incarnation \in Incarnations :
          CreateNextIncarnation(id, incarnation)
    \/ \E instance \in Instances : ReuseRetiredIncarnation(instance)

Spec == Init /\ [][Next]_vars

=============================================================================
