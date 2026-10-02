----------------- MODULE SnapshotGcLifecycleSafety -----------------
EXTENDS SnapshotGcLifecycle

MaxRefs == Cardinality(Versions)

TypeOK ==
    /\ headVersion \in usedVersions
    /\ usedVersions \subseteq Versions
    /\ snapshotRoot \in [Snapshots -> Versions \cup {NoVersion}]
    /\ activeSnapshots \subseteq Snapshots
    /\ retiredSnapshots \subseteq Snapshots
    /\ activeSnapshots \cap retiredSnapshots = {}
    /\ \A snapshot \in activeSnapshots \cup retiredSnapshots :
           snapshotRoot[snapshot] \in usedVersions
    /\ \A snapshot \in Snapshots \
                      (activeSnapshots \cup retiredSnapshots) :
           snapshotRoot[snapshot] = NoVersion
    /\ volumeRoot \in [Volumes -> Versions \cup {NoVersion}]
    /\ activeVolumes \subseteq Volumes
    /\ retiredVolumes \subseteq Volumes
    /\ activeVolumes \cap retiredVolumes = {}
    /\ \A volume \in activeVolumes \cup retiredVolumes :
           volumeRoot[volume] \in usedVersions
    /\ \A volume \in Volumes \ (activeVolumes \cup retiredVolumes) :
           volumeRoot[volume] = NoVersion
    /\ coldLocation \in [Versions -> Packs \cup {NoPack}]
    /\ \A version \in Versions \ usedVersions :
           coldLocation[version] = NoPack
    /\ refCount \in [Packs -> 0..MaxRefs]
    /\ packState \in [Packs -> PackStates]
    /\ outbox \in [Packs -> OutboxStates]
    /\ cosStored \subseteq Packs
    /\ unsafeOutbox \in BOOLEAN
    /\ unsafeReferencedDelete \in BOOLEAN
    /\ unsafeWrongKey \in BOOLEAN
    /\ unsafeUnknownComplete \in BOOLEAN
    /\ unsafeResurrection \in BOOLEAN
    /\ unsafeListDelete \in BOOLEAN
    /\ unsafeRootAccounting \in BOOLEAN

ColdLocationReferenceCountsExact ==
    \A pack \in Packs : refCount[pack] = ExpectedRefs(pack)

ReachableVersionsStayReadable ==
    \A version \in ReachableVersions : VersionReadable(version)

TransactionalGcOutbox ==
    \A pack \in Packs :
        /\ packState[pack] = "Deleting" => outbox[pack] = "Pending"
        /\ packState[pack] = "Deleted" => outbox[pack] = "Done"

NoReferencedPackDeletion ==
    \A pack \in Packs :
        refCount[pack] > 0 =>
            /\ packState[pack] = "Live"
            /\ pack \in cosStored

ExactKeyDeletionOnly == ~unsafeWrongKey

DeleteCompletionReflectsTruth ==
    \A pack \in Packs : packState[pack] = "Deleted" => pack \notin cosStored

NoReferenceResurrection == ReachableVersionsStayReadable

ListNeverAuthorizesDeletion == ~unsafeListDelete
LogicalRootsDoNotOwnPackRefs == ColdLocationReferenceCountsExact

Safety ==
    /\ TypeOK
    /\ ColdLocationReferenceCountsExact
    /\ ReachableVersionsStayReadable
    /\ TransactionalGcOutbox
    /\ NoReferencedPackDeletion
    /\ ExactKeyDeletionOnly
    /\ DeleteCompletionReflectsTruth
    /\ NoReferenceResurrection
    /\ ListNeverAuthorizesDeletion
    /\ LogicalRootsDoNotOwnPackRefs

=====================================================================
