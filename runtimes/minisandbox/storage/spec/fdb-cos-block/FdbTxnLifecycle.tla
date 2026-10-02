------------------------- MODULE FdbTxnLifecycle -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Writers, OpIds, Attempts, MaxEpoch, MaxSeq, Mutation

NoWriter == "NoWriter"
NoOp == "NoOp"
NoVersion == [epoch |-> 0, seq |-> 0]

Version(opEpoch, opSeq) == [epoch |-> opEpoch, seq |-> opSeq]

Versions ==
    {NoVersion} \cup
    {Version(opEpoch, opSeq) :
        opEpoch \in 1..MaxEpoch, opSeq \in 1..MaxSeq}

VersionLE(left, right) ==
    \/ left.epoch < right.epoch
    \/ /\ left.epoch = right.epoch
       /\ left.seq <= right.seq

AttemptStates == {
    "Free",
    "Sent",
    "AmbiguousInFlight",
    "KnownCommitted",
    "UnknownTerminal",
    "LateTerminal",
    "Aborted"
}

ASSUME /\ Writers # {}
       /\ OpIds # {}
       /\ Attempts # {}
       /\ MaxEpoch \in Nat \ {0}
       /\ MaxSeq \in Nat \ {0}
       /\ NoWriter \notin Writers
       /\ NoOp \notin OpIds
       /\ Mutation \in {
            "None",
            "MissingOpConflict",
            "MissingEpochConflict",
            "BlindHeadOverwrite",
            "GcResultEarly",
            "AckBeforeCommit",
            "SequenceOnlyVersion",
            "CommitUnknownStaysInFlight"
          }

InitialWriter == CHOOSE writer \in Writers : TRUE

VARIABLES
    epoch,
    currentWriter,
    nextSeq,
    retiredEpoch,
    submittedOps,
    opEpoch,
    opSeq,
    opWriter,
    attemptState,
    attemptOp,
    opResult,
    committedOps,
    committedVersions,
    ackedOps,
    retryClosed,
    applyCount,
    headVersion,
    staleMutation,
    duplicateApply,
    unknownLateApply,
    unsafeGc

vars == <<
    epoch,
    currentWriter,
    nextSeq,
    retiredEpoch,
    submittedOps,
    opEpoch,
    opSeq,
    opWriter,
    attemptState,
    attemptOp,
    opResult,
    committedOps,
    committedVersions,
    ackedOps,
    retryClosed,
    applyCount,
    headVersion,
    staleMutation,
    duplicateApply,
    unknownLateApply,
    unsafeGc
>>

OpVersion(op) ==
    IF Mutation = "SequenceOnlyVersion"
    THEN Version(1, opSeq[op])
    ELSE Version(opEpoch[op], opSeq[op])

AttemptsInFlightFor(op) ==
    {attempt \in Attempts :
        /\ attemptOp[attempt] = op
        /\ attemptState[attempt] \in {"Sent", "AmbiguousInFlight"}}

AllAttemptsTerminal(op) == AttemptsInFlightFor(op) = {}

OpsInEpoch(targetEpoch) ==
    {op \in submittedOps : opEpoch[op] = targetEpoch}

AllRetriesClosedForEpoch(targetEpoch) ==
    OpsInEpoch(targetEpoch) \subseteq retryClosed

EpochGuard(op) ==
    \/ opEpoch[op] = epoch
    \/ Mutation = "MissingEpochConflict"

OpResultGuard(op) ==
    \/ opResult[op] = NoVersion
    \/ Mutation = "MissingOpConflict"

CanCommit(attempt) ==
    LET op == attemptOp[attempt] IN
    /\ op \in submittedOps
    /\ EpochGuard(op)
    /\ OpResultGuard(op)

ApplyData(attempt) ==
    LET op == attemptOp[attempt]
        version == OpVersion(op)
    IN
    /\ opResult' = [opResult EXCEPT ![op] = version]
    /\ committedOps' = committedOps \cup {op}
    /\ committedVersions' = committedVersions \cup {version}
    /\ applyCount' = [applyCount EXCEPT ![op] = @ + 1]
    /\ headVersion' =
           IF Mutation = "BlindHeadOverwrite"
           THEN version
           ELSE IF VersionLE(headVersion, version)
                THEN version
                ELSE headVersion
    /\ staleMutation' = (staleMutation \/ opEpoch[op] # epoch)
    /\ duplicateApply' = (duplicateApply \/ applyCount[op] > 0)

Init ==
    /\ epoch = 1
    /\ currentWriter = InitialWriter
    /\ nextSeq = 1
    /\ retiredEpoch = 0
    /\ submittedOps = {}
    /\ opEpoch = [op \in OpIds |-> 0]
    /\ opSeq = [op \in OpIds |-> 0]
    /\ opWriter = [op \in OpIds |-> NoWriter]
    /\ attemptState = [attempt \in Attempts |-> "Free"]
    /\ attemptOp = [attempt \in Attempts |-> NoOp]
    /\ opResult = [op \in OpIds |-> NoVersion]
    /\ committedOps = {}
    /\ committedVersions = {}
    /\ ackedOps = {}
    /\ retryClosed = {}
    /\ applyCount = [op \in OpIds |-> 0]
    /\ headVersion = NoVersion
    /\ staleMutation = FALSE
    /\ duplicateApply = FALSE
    /\ unknownLateApply = FALSE
    /\ unsafeGc = FALSE

SubmitOp(writer, op) ==
    /\ writer = currentWriter
    /\ op \notin submittedOps
    /\ nextSeq <= MaxSeq
    /\ submittedOps' = submittedOps \cup {op}
    /\ opEpoch' = [opEpoch EXCEPT ![op] = epoch]
    /\ opSeq' = [opSeq EXCEPT ![op] = nextSeq]
    /\ opWriter' = [opWriter EXCEPT ![op] = writer]
    /\ nextSeq' = nextSeq + 1
    /\ UNCHANGED <<
           epoch, currentWriter, retiredEpoch, attemptState, attemptOp,
           opResult, committedOps, committedVersions, ackedOps, retryClosed,
           applyCount, headVersion, staleMutation, duplicateApply,
           unknownLateApply, unsafeGc
       >>

StartAttempt(op, attempt) ==
    /\ op \in submittedOps
    /\ op \notin ackedOps
    /\ op \notin retryClosed
    /\ opEpoch[op] = epoch
    /\ opResult[op] = NoVersion
    /\ attemptState[attempt] = "Free"
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "Sent"]
    /\ attemptOp' = [attemptOp EXCEPT ![attempt] = op]
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, opResult, committedOps,
           committedVersions, ackedOps, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

CommitKnown(attempt) ==
    LET op == attemptOp[attempt] IN
    /\ attemptState[attempt] = "Sent"
    /\ CanCommit(attempt)
    /\ ApplyData(attempt)
    /\ attemptState' =
           [attemptState EXCEPT ![attempt] = "KnownCommitted"]
    /\ ackedOps' = ackedOps \cup {op}
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptOp, retryClosed,
           unknownLateApply, unsafeGc
       >>

CommitUnknownApplied(attempt) ==
    /\ attemptState[attempt] = "Sent"
    /\ CanCommit(attempt)
    /\ ApplyData(attempt)
    /\ attemptState' =
           [attemptState EXCEPT ![attempt] = "UnknownTerminal"]
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptOp, ackedOps, retryClosed,
           unknownLateApply, unsafeGc
       >>

CommitUnknownNotApplied(attempt) ==
    /\ attemptState[attempt] = "Sent"
    /\ attemptState' =
           [attemptState EXCEPT ![attempt] = "UnknownTerminal"]
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptOp, opResult, committedOps,
           committedVersions, ackedOps, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

AbortKnown(attempt) ==
    /\ attemptState[attempt] = "Sent"
    /\ ~CanCommit(attempt)
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "Aborted"]
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptOp, opResult, committedOps,
           committedVersions, ackedOps, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

TimeoutOrCancel(attempt) ==
    /\ attemptState[attempt] = "Sent"
    /\ attemptState' =
           [attemptState EXCEPT ![attempt] = "AmbiguousInFlight"]
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptOp, opResult, committedOps,
           committedVersions, ackedOps, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

LateCommit(attempt) ==
    /\ attemptState[attempt] = "AmbiguousInFlight"
    /\ CanCommit(attempt)
    /\ ApplyData(attempt)
    /\ attemptState' =
           [attemptState EXCEPT ![attempt] = "LateTerminal"]
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptOp, ackedOps, retryClosed,
           unknownLateApply, unsafeGc
       >>

LateAbort(attempt) ==
    /\ attemptState[attempt] = "AmbiguousInFlight"
    /\ attemptState' = [attemptState EXCEPT ![attempt] = "Aborted"]
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptOp, opResult, committedOps,
           committedVersions, ackedOps, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

LateCommitAfterCommitUnknown(attempt) ==
    LET op == attemptOp[attempt] IN
    /\ Mutation = "CommitUnknownStaysInFlight"
    /\ attemptState[attempt] = "UnknownTerminal"
    /\ applyCount[op] = 0
    /\ CanCommit(attempt)
    /\ ApplyData(attempt)
    /\ attemptState' =
           [attemptState EXCEPT ![attempt] = "LateTerminal"]
    /\ unknownLateApply' = TRUE
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptOp, ackedOps, retryClosed,
           unsafeGc
       >>

ReconcileCommitted(op) ==
    /\ op \in submittedOps
    /\ opResult[op] # NoVersion
    /\ op \notin ackedOps
    /\ ackedOps' = ackedOps \cup {op}
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptState, attemptOp, opResult,
           committedOps, committedVersions, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

AcknowledgeBeforeCommit(op) ==
    /\ Mutation = "AckBeforeCommit"
    /\ op \in submittedOps
    /\ opResult[op] = NoVersion
    /\ op \notin ackedOps
    /\ ackedOps' = ackedOps \cup {op}
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptState, attemptOp, opResult,
           committedOps, committedVersions, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

CloseRetryWindow(op) ==
    /\ op \in ackedOps
    /\ op \notin retryClosed
    /\ AllAttemptsTerminal(op)
    /\ retryClosed' = retryClosed \cup {op}
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptState, attemptOp, opResult,
           committedOps, committedVersions, ackedOps, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

Recover(writer) ==
    /\ epoch < MaxEpoch
    /\ epoch' = epoch + 1
    /\ currentWriter' = writer
    /\ nextSeq' = 1
    /\ UNCHANGED <<
           retiredEpoch, submittedOps, opEpoch, opSeq, opWriter,
           attemptState, attemptOp, opResult, committedOps,
           committedVersions, ackedOps, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

RetireNextEpoch ==
    /\ retiredEpoch < epoch - 1
    /\ AllRetriesClosedForEpoch(retiredEpoch + 1)
    /\ retiredEpoch' = retiredEpoch + 1
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, submittedOps, opEpoch, opSeq,
           opWriter, attemptState, attemptOp, opResult, committedOps,
           committedVersions, ackedOps, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply,
           unsafeGc
       >>

ResultGcSafe(op) ==
    /\ op \in retryClosed
    /\ opEpoch[op] <= retiredEpoch
    /\ AllAttemptsTerminal(op)

GcResult(op) ==
    /\ op \in committedOps
    /\ opResult[op] # NoVersion
    /\ \/ ResultGcSafe(op)
       \/ Mutation = "GcResultEarly"
    /\ opResult' = [opResult EXCEPT ![op] = NoVersion]
    /\ unsafeGc' = (unsafeGc \/ ~ResultGcSafe(op))
    /\ UNCHANGED <<
           epoch, currentWriter, nextSeq, retiredEpoch, submittedOps,
           opEpoch, opSeq, opWriter, attemptState, attemptOp, committedOps,
           committedVersions, ackedOps, retryClosed, applyCount,
           headVersion, staleMutation, duplicateApply, unknownLateApply
       >>

Next ==
    \/ \E writer \in Writers, op \in OpIds : SubmitOp(writer, op)
    \/ \E op \in OpIds, attempt \in Attempts : StartAttempt(op, attempt)
    \/ \E attempt \in Attempts : CommitKnown(attempt)
    \/ \E attempt \in Attempts : CommitUnknownApplied(attempt)
    \/ \E attempt \in Attempts : CommitUnknownNotApplied(attempt)
    \/ \E attempt \in Attempts : AbortKnown(attempt)
    \/ \E attempt \in Attempts : TimeoutOrCancel(attempt)
    \/ \E attempt \in Attempts : LateCommit(attempt)
    \/ \E attempt \in Attempts : LateAbort(attempt)
    \/ \E attempt \in Attempts : LateCommitAfterCommitUnknown(attempt)
    \/ \E op \in OpIds : ReconcileCommitted(op)
    \/ \E op \in OpIds : AcknowledgeBeforeCommit(op)
    \/ \E op \in OpIds : CloseRetryWindow(op)
    \/ \E writer \in Writers : Recover(writer)
    \/ RetireNextEpoch
    \/ \E op \in OpIds : GcResult(op)

Spec == Init /\ [][Next]_vars

=============================================================================
