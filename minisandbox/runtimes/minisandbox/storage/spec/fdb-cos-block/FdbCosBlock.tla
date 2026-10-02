-------------------------- MODULE FdbCosBlock --------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Blocks, Values, Writers, MaxVersion, MaxEpoch, Mutation

ASSUME /\ Blocks # {}
       /\ Values # {}
       /\ Writers # {}
       /\ MaxVersion \in Nat \ {0}
       /\ MaxEpoch \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "AckFlushEarly",
            "AcceptStaleCommit",
            "PublishUnverifiedCos",
            "EvictBeforePublish",
            "EvictPinnedSnapshot",
            "BlindRetryUnknown"
          }

NoObj == [block |-> "NoBlock", version |-> 0, value |-> "NoValue"]
Obj(block, version, value) ==
    [block |-> block, version |-> version, value |-> value]

ObjectUniverse ==
    {NoObj} \cup
    {Obj(block, version, value) :
        block \in Blocks, version \in 1..MaxVersion, value \in Values}

EmptyImage == [block \in Blocks |-> NoObj]
Images == [Blocks -> ObjectUniverse]

ImageTypeOK(image) ==
    /\ image \in Images
    /\ \A block \in Blocks :
           \/ image[block] = NoObj
           \/ image[block].block = block

LatestObject(left, right) ==
    IF right.version >= left.version THEN right ELSE left

LatestImage(left, right) ==
    [block \in Blocks |-> LatestObject(left[block], right[block])]

ObjectsIn(image) == {image[block] : block \in Blocks} \ {NoObj}

InitialWriter == CHOOSE writer \in Writers : TRUE

WriteOp(writer, opEpoch, object) ==
    [writer |-> writer, epoch |-> opEpoch, object |-> object]

CosOp(writer, opEpoch, object) ==
    [writer |-> writer, epoch |-> opEpoch, object |-> object]

VARIABLES
    running,
    epoch,
    heldEpoch,
    nextVersion,
    submitted,
    issued,
    pendingWrites,
    retryWrites,
    unknownWrites,
    committedWrites,
    ackedWrites,
    fdbData,
    head,
    flushPhase,
    flushImage,
    ackedFlush,
    snapshotImage,
    cosObjects,
    verified,
    putOps,
    headOps,
    coldIndex,
    staleRejected,
    staleMutation,
    unsafeCosPublish,
    unsafeEvict,
    duplicateApply

vars == <<
    running,
    epoch,
    heldEpoch,
    nextVersion,
    submitted,
    issued,
    pendingWrites,
    retryWrites,
    unknownWrites,
    committedWrites,
    ackedWrites,
    fdbData,
    head,
    flushPhase,
    flushImage,
    ackedFlush,
    snapshotImage,
    cosObjects,
    verified,
    putOps,
    headOps,
    coldIndex,
    staleRejected,
    staleMutation,
    unsafeCosPublish,
    unsafeEvict,
    duplicateApply
>>

Current(writer) ==
    /\ running
    /\ heldEpoch[writer] = epoch

OpEpochCurrent(op) ==
    /\ op.epoch = epoch
    /\ heldEpoch[op.writer] = epoch

OpIsCurrent(op) ==
    /\ running
    /\ OpEpochCurrent(op)

Recoverable(object) ==
    \/ object \in fdbData
    \/ /\ object \in coldIndex
       /\ object.value \in cosObjects

ImageCovered(image) ==
    \A block \in Blocks :
        \/ image[block] = NoObj
        \/ /\ head[block] # NoObj
           /\ head[block].version >= image[block].version
           /\ Recoverable(head[block])

Init ==
    /\ running = TRUE
    /\ epoch = 1
    /\ heldEpoch =
           [writer \in Writers |-> IF writer = InitialWriter THEN 1 ELSE 0]
    /\ nextVersion = 1
    /\ submitted = EmptyImage
    /\ issued = {}
    /\ pendingWrites = {}
    /\ retryWrites = {}
    /\ unknownWrites = {}
    /\ committedWrites = {}
    /\ ackedWrites = {}
    /\ fdbData = {}
    /\ head = EmptyImage
    /\ flushPhase = "Idle"
    /\ flushImage = EmptyImage
    /\ ackedFlush = EmptyImage
    /\ snapshotImage = EmptyImage
    /\ cosObjects = {}
    /\ verified = {}
    /\ putOps = {}
    /\ headOps = {}
    /\ coldIndex = {}
    /\ staleRejected = FALSE
    /\ staleMutation = FALSE
    /\ unsafeCosPublish = FALSE
    /\ unsafeEvict = FALSE
    /\ duplicateApply = FALSE

SubmitWrite(writer, block, value) ==
    LET object == Obj(block, nextVersion, value)
        op == WriteOp(writer, epoch, object)
    IN
    /\ Current(writer)
    /\ nextVersion <= MaxVersion
    /\ op \notin pendingWrites \cup retryWrites \cup unknownWrites
    /\ submitted' = [submitted EXCEPT ![block] = object]
    /\ issued' = issued \cup {object}
    /\ pendingWrites' = pendingWrites \cup {op}
    /\ nextVersion' = nextVersion + 1
    /\ UNCHANGED <<
           running, epoch, heldEpoch, retryWrites, unknownWrites,
           committedWrites, ackedWrites, fdbData, head,
           flushPhase, flushImage, ackedFlush, snapshotImage, cosObjects, verified,
           putOps, headOps, coldIndex, staleRejected, staleMutation,
           unsafeCosPublish, unsafeEvict, duplicateApply
       >>

KnownCommitMayApply(op) ==
    \/ OpIsCurrent(op)
    \/ /\ Mutation = "AcceptStaleCommit"
       /\ running
       /\ ~OpEpochCurrent(op)

UnknownCommitMayApply(op) ==
    \/ OpEpochCurrent(op)
    \/ /\ Mutation = "AcceptStaleCommit"
       /\ ~OpEpochCurrent(op)

FdbCommitKnown(op) ==
    LET apply == KnownCommitMayApply(op)
        object == op.object
        old == head[object.block]
    IN
    /\ op \in pendingWrites
    \* A known reply can only reach a live client. A server-side commit that
    \* finishes after client crash is represented by UnknownApplied instead.
    /\ (running \/ Mutation = "AcceptStaleCommit")
    /\ pendingWrites' = pendingWrites \ {op}
    /\ IF apply
       THEN /\ fdbData' = fdbData \cup {object}
            /\ head' =
                   IF object.version >= old.version
                   THEN [head EXCEPT ![object.block] = object]
                   ELSE head
            /\ committedWrites' = committedWrites \cup {op}
            /\ ackedWrites' = ackedWrites \cup {op}
            /\ duplicateApply' =
                   (duplicateApply \/ (op \in committedWrites))
            /\ staleMutation' =
                   (staleMutation \/ ~OpEpochCurrent(op))
            /\ UNCHANGED staleRejected
       ELSE /\ staleRejected' = TRUE
            /\ UNCHANGED <<
                   fdbData, head, committedWrites, ackedWrites,
                   duplicateApply, staleMutation
               >>
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           retryWrites, unknownWrites, flushPhase, flushImage,
           ackedFlush, snapshotImage, cosObjects, verified, putOps, headOps,
           coldIndex, unsafeCosPublish, unsafeEvict
       >>

FdbCommitUnknownApplied(op) ==
    LET apply == UnknownCommitMayApply(op)
        object == op.object
        old == head[object.block]
    IN
    /\ op \in pendingWrites
    /\ pendingWrites' = pendingWrites \ {op}
    /\ IF apply
       THEN /\ fdbData' = fdbData \cup {object}
            /\ head' =
                   IF object.version >= old.version
                   THEN [head EXCEPT ![object.block] = object]
                   ELSE head
            /\ committedWrites' = committedWrites \cup {op}
            /\ unknownWrites' = unknownWrites \cup {op}
            /\ duplicateApply' =
                   (duplicateApply \/ (op \in committedWrites))
            /\ staleMutation' =
                   (staleMutation \/ ~OpEpochCurrent(op))
            /\ UNCHANGED staleRejected
       ELSE /\ staleRejected' = TRUE
            /\ UNCHANGED <<
                   fdbData, head, committedWrites, unknownWrites,
                   duplicateApply, staleMutation
               >>
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           retryWrites, ackedWrites, flushPhase, flushImage,
           ackedFlush, snapshotImage, cosObjects, verified, putOps, headOps,
           coldIndex, unsafeCosPublish, unsafeEvict
       >>

FdbCommitUnknownNotApplied(op) ==
    /\ op \in pendingWrites
    /\ pendingWrites' = pendingWrites \ {op}
    /\ retryWrites' = retryWrites \cup {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           unknownWrites, committedWrites, ackedWrites, fdbData, head,
           flushPhase, flushImage, ackedFlush, snapshotImage, cosObjects, verified,
           putOps, headOps, coldIndex, staleRejected, staleMutation,
           unsafeCosPublish, unsafeEvict, duplicateApply
       >>

ResolveCommittedUnknown(op) ==
    /\ op \in unknownWrites
    /\ op \in committedWrites
    /\ unknownWrites' = unknownWrites \ {op}
    /\ ackedWrites' = ackedWrites \cup {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, committedWrites, fdbData, head,
           flushPhase, flushImage, ackedFlush, snapshotImage, cosObjects, verified,
           putOps, headOps, coldIndex, staleRejected, staleMutation,
           unsafeCosPublish, unsafeEvict, duplicateApply
       >>

RetryUncommitted(op) ==
    /\ op \in retryWrites
    /\ OpIsCurrent(op)
    /\ retryWrites' = retryWrites \ {op}
    /\ pendingWrites' = pendingWrites \cup {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           unknownWrites, committedWrites, ackedWrites, fdbData, head,
           flushPhase, flushImage, ackedFlush, snapshotImage, cosObjects, verified,
           putOps, headOps, coldIndex, staleRejected, staleMutation,
           unsafeCosPublish, unsafeEvict, duplicateApply
       >>

BlindRetryUnknown(op) ==
    /\ Mutation = "BlindRetryUnknown"
    /\ op \in unknownWrites
    /\ unknownWrites' = unknownWrites \ {op}
    /\ pendingWrites' = pendingWrites \cup {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           retryWrites, committedWrites, ackedWrites, fdbData, head,
           flushPhase, flushImage, ackedFlush, snapshotImage, cosObjects, verified,
           putOps, headOps, coldIndex, staleRejected, staleMutation,
           unsafeCosPublish, unsafeEvict, duplicateApply
       >>

RejectStaleRetry(op) ==
    /\ op \in retryWrites
    /\ ~OpIsCurrent(op)
    /\ retryWrites' = retryWrites \ {op}
    /\ staleRejected' = TRUE
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, unknownWrites, committedWrites, ackedWrites,
           fdbData, head, flushPhase, flushImage, ackedFlush, snapshotImage,
           cosObjects, verified, putOps, headOps, coldIndex,
           staleMutation, unsafeCosPublish, unsafeEvict, duplicateApply
       >>

BeginFlush(writer) ==
    /\ Current(writer)
    /\ flushPhase = "Idle"
    /\ ObjectsIn(submitted) # {}
    /\ flushPhase' = "Pending"
    /\ flushImage' = submitted
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, ackedFlush, snapshotImage, cosObjects, verified,
           putOps, headOps, coldIndex, staleRejected, staleMutation,
           unsafeCosPublish, unsafeEvict, duplicateApply
       >>

AckFlush ==
    /\ running
    /\ flushPhase = "Pending"
    /\ \/ ImageCovered(flushImage)
       \/ Mutation = "AckFlushEarly"
    /\ ackedFlush' = LatestImage(ackedFlush, flushImage)
    /\ flushPhase' = "Idle"
    /\ flushImage' = EmptyImage
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, snapshotImage, cosObjects, verified,
           putOps, headOps, coldIndex, staleRejected, staleMutation,
           unsafeCosPublish, unsafeEvict, duplicateApply
       >>

PinSnapshot(writer) ==
    /\ Current(writer)
    /\ snapshotImage = EmptyImage
    /\ ObjectsIn(head) # {}
    /\ ImageCovered(submitted)
    /\ snapshotImage' = head
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, cosObjects, verified, putOps, headOps, coldIndex,
           staleRejected, staleMutation, unsafeCosPublish, unsafeEvict,
           duplicateApply
       >>

StartPut(writer, object) ==
    LET op == CosOp(writer, epoch, object) IN
    /\ Current(writer)
    /\ object \in fdbData
    /\ op \notin putOps
    /\ putOps' = putOps \cup {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, snapshotImage, cosObjects, verified, headOps, coldIndex,
           staleRejected, staleMutation, unsafeCosPublish, unsafeEvict,
           duplicateApply
       >>

PutSuccess(op) ==
    /\ op \in putOps
    /\ putOps' = putOps \ {op}
    /\ cosObjects' = cosObjects \cup {op.object.value}
    \* A known-success PUT whose request/response integrity fields were
    \* checked establishes storage identity. It does not make later GET
    \* observations monotonic; that is modeled in CosReadLifecycle.tla.
    /\ verified' =
           IF OpIsCurrent(op)
           THEN verified \cup {op.object}
           ELSE verified
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, snapshotImage, headOps, coldIndex, staleRejected,
           staleMutation,
           unsafeCosPublish, unsafeEvict, duplicateApply
       >>

PutUnknownApplied(op) ==
    /\ op \in putOps
    /\ putOps' = putOps \ {op}
    /\ cosObjects' = cosObjects \cup {op.object.value}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, snapshotImage, verified, headOps, coldIndex, staleRejected,
           staleMutation, unsafeCosPublish, unsafeEvict, duplicateApply
       >>

PutUnknownNotApplied(op) ==
    /\ op \in putOps
    /\ putOps' = putOps \ {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, snapshotImage, cosObjects, verified, headOps, coldIndex,
           staleRejected, staleMutation, unsafeCosPublish, unsafeEvict,
           duplicateApply
       >>

StartHead(writer, object) ==
    LET op == CosOp(writer, epoch, object) IN
    /\ Current(writer)
    /\ object \in issued
    /\ op \notin headOps
    /\ headOps' = headOps \cup {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, snapshotImage, cosObjects, verified, putOps, coldIndex,
           staleRejected, staleMutation, unsafeCosPublish, unsafeEvict,
           duplicateApply
       >>

HeadCorrect(op) ==
    /\ op \in headOps
    /\ op.object.value \in cosObjects
    /\ headOps' = headOps \ {op}
    /\ verified' =
           IF OpIsCurrent(op)
           THEN verified \cup {op.object}
           ELSE verified
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, snapshotImage, cosObjects, putOps, coldIndex, staleRejected,
           staleMutation, unsafeCosPublish, unsafeEvict, duplicateApply
       >>

HeadNotFoundOrStale(op) ==
    /\ op \in headOps
    /\ headOps' = headOps \ {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, snapshotImage, cosObjects, verified, putOps, coldIndex,
           staleRejected, staleMutation, unsafeCosPublish, unsafeEvict,
           duplicateApply
       >>

PublishCold(writer, object) ==
    /\ Current(writer)
    /\ object \in issued
    /\ \/ /\ object \in verified
           /\ object.value \in cosObjects
       \/ Mutation = "PublishUnverifiedCos"
    /\ coldIndex' = coldIndex \cup {object}
    /\ unsafeCosPublish' =
           (unsafeCosPublish \/ (object \notin verified))
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, snapshotImage, cosObjects, verified, putOps, headOps,
           staleRejected, staleMutation, unsafeEvict, duplicateApply
       >>

ReferencedByLiveState(object) ==
    \/ object \in ObjectsIn(head)
    \/ object \in ObjectsIn(flushImage)
    \/ object \in ObjectsIn(snapshotImage)

\* ackedFlush is a specification-history variable, not implementation state.
\* Reclamation must be safe without consulting that ghost oracle.

SafeToEvict(object) ==
    \/ ~ReferencedByLiveState(object)
    \/ /\ object \in coldIndex
       /\ object.value \in cosObjects

EvictHot(writer, object) ==
    /\ Current(writer)
    /\ object \in fdbData
    /\ \/ SafeToEvict(object)
       \/ Mutation = "EvictBeforePublish"
       \/ /\ Mutation = "EvictPinnedSnapshot"
          /\ object \in ObjectsIn(snapshotImage)
          /\ object \notin ObjectsIn(head)
    /\ fdbData' = fdbData \ {object}
    /\ unsafeEvict' = (unsafeEvict \/ ~SafeToEvict(object))
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, head, flushPhase, flushImage, ackedFlush, snapshotImage,
           cosObjects, verified, putOps, headOps, coldIndex,
           staleRejected, staleMutation, unsafeCosPublish, duplicateApply
       >>

Crash ==
    /\ running
    /\ running' = FALSE
    /\ verified' = {}
    /\ UNCHANGED <<
           epoch, heldEpoch, nextVersion, submitted, issued,
           pendingWrites, retryWrites, unknownWrites, committedWrites,
           ackedWrites, fdbData, head, flushPhase, flushImage,
           ackedFlush, snapshotImage, cosObjects, putOps, headOps, coldIndex,
           staleRejected, staleMutation, unsafeCosPublish, unsafeEvict,
           duplicateApply
       >>

Recover(writer) ==
    /\ ~running
    /\ epoch < MaxEpoch
    /\ running' = TRUE
    /\ epoch' = epoch + 1
    /\ heldEpoch' = [heldEpoch EXCEPT ![writer] = epoch + 1]
    /\ submitted' = head
    /\ flushPhase' = "Idle"
    /\ flushImage' = EmptyImage
    /\ UNCHANGED <<
           nextVersion, issued, pendingWrites, retryWrites, unknownWrites,
           committedWrites, ackedWrites, fdbData, head, ackedFlush, snapshotImage,
           cosObjects, verified, putOps, headOps, coldIndex,
           staleRejected, staleMutation, unsafeCosPublish, unsafeEvict,
           duplicateApply
       >>

Next ==
    \/ \E writer \in Writers, block \in Blocks, value \in Values :
           SubmitWrite(writer, block, value)
    \/ \E op \in pendingWrites : FdbCommitKnown(op)
    \/ \E op \in pendingWrites : FdbCommitUnknownApplied(op)
    \/ \E op \in pendingWrites : FdbCommitUnknownNotApplied(op)
    \/ \E op \in unknownWrites : ResolveCommittedUnknown(op)
    \/ \E op \in retryWrites : RetryUncommitted(op)
    \/ \E op \in unknownWrites : BlindRetryUnknown(op)
    \/ \E op \in retryWrites : RejectStaleRetry(op)
    \/ \E writer \in Writers : BeginFlush(writer)
    \/ AckFlush
    \/ \E writer \in Writers : PinSnapshot(writer)
    \/ \E writer \in Writers, object \in fdbData :
           StartPut(writer, object)
    \/ \E op \in putOps : PutSuccess(op)
    \/ \E op \in putOps : PutUnknownApplied(op)
    \/ \E op \in putOps : PutUnknownNotApplied(op)
    \/ \E writer \in Writers, object \in issued :
           StartHead(writer, object)
    \/ \E op \in headOps : HeadCorrect(op)
    \/ \E op \in headOps : HeadNotFoundOrStale(op)
    \/ \E writer \in Writers, object \in issued :
           PublishCold(writer, object)
    \/ \E writer \in Writers, object \in fdbData :
           EvictHot(writer, object)
    \/ Crash
    \/ \E writer \in Writers : Recover(writer)

Spec == Init /\ [][Next]_vars

=============================================================================
