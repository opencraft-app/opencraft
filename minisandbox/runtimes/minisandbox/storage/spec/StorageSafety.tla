-------------------------- MODULE StorageSafety --------------------------
EXTENDS Storage

\* Safety requirements are kept outside the algorithm transition module so
\* changes to Next do not silently redefine their oracle.

Source(block) ==
    IF cbsHead[block] # NoObj THEN cbsHead[block] ELSE manifest[block]

SourceIsDurable(block) ==
    IF cbsHead[block] # NoObj
    THEN cbsHead[block] \in cbsData
    ELSE manifest[block] = NoObj \/ manifest[block].value \in s3Objects

TypeOK ==
    /\ running \in BOOLEAN
    /\ epoch \in 1..MaxEpoch
    /\ heldEpoch \in [Writers -> 0..MaxEpoch]
    /\ nextVersion \in 1..(MaxVersion + 1)
    /\ ImageTypeOK(volatile)
    /\ issued \subseteq ObjectUniverse \ {NoObj}
    /\ cbsData \subseteq issued
    /\ ImageTypeOK(cbsHead)
    /\ flushPhase \in {"Idle", "Pending", "Synced"}
    /\ ImageTypeOK(flushImage)
    /\ ImageTypeOK(acked)
    /\ s3Objects \subseteq Values
    /\ verified \subseteq issued
    /\ \A op \in putOps :
           /\ op.writer \in Writers
           /\ op.epoch \in 1..MaxEpoch
           /\ op.object \in issued
    /\ \A op \in headOps :
           /\ op.writer \in Writers
           /\ op.epoch \in 1..MaxEpoch
           /\ op.object \in issued
    /\ \A op \in commitOps :
           /\ op.writer \in Writers
           /\ op.epoch \in 1..MaxEpoch
           /\ op.expected \in 0..MaxCommits
           /\ ImageTypeOK(op.image)
    /\ manifestGen \in 0..MaxCommits
    /\ ImageTypeOK(manifest)
    /\ manifestHighWater \in [Blocks -> 0..MaxVersion]
    /\ successfulCas \subseteq 0..(MaxCommits - 1)
    /\ staleRejected \in BOOLEAN
    /\ staleMutation \in BOOLEAN
    /\ duplicateCasSuccess \in BOOLEAN

ObjectAuthenticity ==
    /\ ObjectsIn(volatile) \subseteq issued
    /\ ObjectsIn(cbsHead) \subseteq issued
    /\ ObjectsIn(flushImage) \subseteq issued
    /\ ObjectsIn(acked) \subseteq issued
    /\ ObjectsIn(manifest) \subseteq issued
    /\ \A op \in commitOps : ObjectsIn(op.image) \subseteq issued

CbsHeadIsDurable ==
    \A block \in Blocks :
        cbsHead[block] = NoObj \/ cbsHead[block] \in cbsData

VerifiedObjectsExist ==
    \A object \in verified : object.value \in s3Objects

ManifestObjectsExist ==
    \A object \in ObjectsIn(manifest) : object.value \in s3Objects

AcknowledgedDataRecoverable ==
    \A block \in Blocks :
        \/ acked[block] = NoObj
        \/ /\ Source(block) # NoObj
           /\ Source(block).block = block
           /\ Source(block).version >= acked[block].version
           /\ SourceIsDurable(block)

ManifestNeverRegresses ==
    /\ manifestGen = Cardinality(successfulCas)
    /\ ~duplicateCasSuccess
    /\ \A block \in Blocks :
           manifest[block].version = manifestHighWater[block]

CbsHeadNeverBehindManifest ==
    \A block \in Blocks :
        \/ cbsHead[block] = NoObj
        \/ cbsHead[block].version >= manifest[block].version

StaleEpochsAreFenced == ~staleMutation

Safety ==
    /\ TypeOK
    /\ ObjectAuthenticity
    /\ CbsHeadIsDurable
    /\ VerifiedObjectsExist
    /\ ManifestObjectsExist
    /\ AcknowledgedDataRecoverable
    /\ ManifestNeverRegresses
    /\ CbsHeadNeverBehindManifest
    /\ StaleEpochsAreFenced

=============================================================================
