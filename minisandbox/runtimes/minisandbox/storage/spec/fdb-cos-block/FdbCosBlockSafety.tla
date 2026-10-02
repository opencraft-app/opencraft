----------------------- MODULE FdbCosBlockSafety -----------------------
EXTENDS FdbCosBlock

\* Kept outside the transition module so an algorithm edit does not
\* automatically redefine the safety oracle beside it.

WriteOpTypeOK(op) ==
    /\ op.writer \in Writers
    /\ op.epoch \in 1..MaxEpoch
    /\ op.object \in issued

CosOpTypeOK(op) == WriteOpTypeOK(op)

TypeOK ==
    /\ running \in BOOLEAN
    /\ epoch \in 1..MaxEpoch
    /\ heldEpoch \in [Writers -> 0..MaxEpoch]
    /\ nextVersion \in 1..(MaxVersion + 1)
    /\ ImageTypeOK(submitted)
    /\ issued \subseteq ObjectUniverse \ {NoObj}
    /\ \A op \in pendingWrites : WriteOpTypeOK(op)
    /\ \A op \in retryWrites : WriteOpTypeOK(op)
    /\ \A op \in unknownWrites : WriteOpTypeOK(op)
    /\ \A op \in committedWrites : WriteOpTypeOK(op)
    /\ \A op \in ackedWrites : WriteOpTypeOK(op)
    /\ fdbData \subseteq issued
    /\ ImageTypeOK(head)
    /\ flushPhase \in {"Idle", "Pending"}
    /\ ImageTypeOK(flushImage)
    /\ ImageTypeOK(ackedFlush)
    /\ ImageTypeOK(snapshotImage)
    /\ cosObjects \subseteq Values
    /\ verified \subseteq issued
    /\ \A op \in putOps : CosOpTypeOK(op)
    /\ \A op \in headOps : CosOpTypeOK(op)
    /\ coldIndex \subseteq issued
    /\ staleRejected \in BOOLEAN
    /\ staleMutation \in BOOLEAN
    /\ unsafeCosPublish \in BOOLEAN
    /\ unsafeEvict \in BOOLEAN
    /\ duplicateApply \in BOOLEAN

LogicalPointersAuthentic ==
    /\ ObjectsIn(submitted) \subseteq issued
    /\ ObjectsIn(head) \subseteq issued
    /\ ObjectsIn(flushImage) \subseteq issued
    /\ ObjectsIn(ackedFlush) \subseteq issued
    /\ ObjectsIn(snapshotImage) \subseteq issued

ObjectHasDurableCopy(object) ==
    \/ object \in fdbData
    \/ /\ object \in coldIndex
       /\ object.value \in cosObjects

OracleImageCovered(image) ==
    \A block \in Blocks :
        \/ image[block] = NoObj
        \/ /\ head[block] # NoObj
           /\ head[block].version >= image[block].version
           /\ ObjectHasDurableCopy(head[block])

CurrentDataRecoverable ==
    \A object \in ObjectsIn(head) : ObjectHasDurableCopy(object)

PinnedSnapshotRecoverable ==
    \A object \in ObjectsIn(snapshotImage) : ObjectHasDurableCopy(object)

AcknowledgedWritesDurable ==
    \A op \in ackedWrites :
        /\ head[op.object.block] # NoObj
        /\ head[op.object.block].version >= op.object.version
        /\ ObjectHasDurableCopy(head[op.object.block])

AcknowledgedFlushRecoverable ==
    OracleImageCovered(ackedFlush)

VerifiedCosObjectsExist ==
    \A object \in verified : object.value \in cosObjects

PublishedCosObjectsExist ==
    \A object \in coldIndex : object.value \in cosObjects

StaleEpochsAreFenced == ~staleMutation

UnknownCommitsAreIdempotent == ~duplicateApply

NoUnverifiedCosPublication == ~unsafeCosPublish

NoUnsafeHotEviction == ~unsafeEvict

Safety ==
    /\ TypeOK
    /\ LogicalPointersAuthentic
    /\ CurrentDataRecoverable
    /\ PinnedSnapshotRecoverable
    /\ AcknowledgedWritesDurable
    /\ AcknowledgedFlushRecoverable
    /\ VerifiedCosObjectsExist
    /\ PublishedCosObjectsExist
    /\ StaleEpochsAreFenced
    /\ UnknownCommitsAreIdempotent
    /\ NoUnverifiedCosPublication
    /\ NoUnsafeHotEviction

=============================================================================
