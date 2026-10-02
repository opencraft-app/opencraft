------------------- MODULE DiscardLifecycleSafety -------------------
EXTENDS DiscardLifecycle

TypeOK ==
    /\ running \in BOOLEAN
    /\ generation \in 1..MaxGeneration
    /\ nextVersion \in 1..(MaxVersion + 1)
    /\ currentVersion \in 0..MaxVersion
    /\ versionKind \in [1..MaxVersion -> Kinds]
    /\ snapshots \subseteq 1..MaxVersion
    /\ opResult \in [Ops -> 0..MaxVersion]
    /\ lastRead \in ReadKinds
    /\ unsafeNoVersion \in BOOLEAN
    /\ unsafeSnapshotMutation \in BOOLEAN
    /\ unsafeFailureZero \in BOOLEAN
    /\ unsafeStaleDiscard \in BOOLEAN

AllocatedVersionsExist ==
    /\ currentVersion # 0 => versionKind[currentVersion] # "Missing"
    /\ \A version \in snapshots : versionKind[version] # "Missing"
    /\ \A op \in Ops : opResult[op] # 0 => versionKind[opResult[op]] # "Missing"

DiscardCreatesVersion == ~unsafeNoVersion
SnapshotRootsImmutable == ~unsafeSnapshotMutation
ZeroReadsAuthorized == ~unsafeFailureZero
StaleGenerationsFenced == ~unsafeStaleDiscard

Safety ==
    /\ TypeOK
    /\ AllocatedVersionsExist
    /\ DiscardCreatesVersion
    /\ SnapshotRootsImmutable
    /\ ZeroReadsAuthorized
    /\ StaleGenerationsFenced

=====================================================================
