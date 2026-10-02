-------------------- MODULE SnapshotGcLifecycle --------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Packs, Versions, Snapshots, Volumes, Mutation

NoPack == "NoPack"
NoVersion == "NoVersion"

ASSUME /\ Cardinality(Packs) > 1
       /\ Versions # {}
       /\ Snapshots # {}
       /\ Volumes # {}
       /\ NoPack \notin Packs
       /\ NoVersion \notin Versions
       /\ Mutation \in {
            "None",
            "GcWithoutOutbox",
            "DeleteReferencedPack",
            "DeleteWrongExactKey",
            "CompleteUnknownDelete",
            "ReferenceDeletingPack",
            "ListAuthorizesDelete",
            "CountRootAsPackRef",
            "RetryDoubleVolumeRelease"
          }

PackStates == {"Live", "Deleting", "Deleted"}
OutboxStates == {"None", "Pending", "Done"}

FirstPack == CHOOSE pack \in Packs : TRUE
FirstVersion == CHOOSE version \in Versions : TRUE

VARIABLES
    headVersion,
    usedVersions,
    snapshotRoot,
    activeSnapshots,
    retiredSnapshots,
    volumeRoot,
    activeVolumes,
    retiredVolumes,
    coldLocation,
    refCount,
    packState,
    outbox,
    cosStored,
    unsafeOutbox,
    unsafeReferencedDelete,
    unsafeWrongKey,
    unsafeUnknownComplete,
    unsafeResurrection,
    unsafeListDelete,
    unsafeRootAccounting

vars == <<
    headVersion,
    usedVersions,
    snapshotRoot,
    activeSnapshots,
    retiredSnapshots,
    volumeRoot,
    activeVolumes,
    retiredVolumes,
    coldLocation,
    refCount,
    packState,
    outbox,
    cosStored,
    unsafeOutbox,
    unsafeReferencedDelete,
    unsafeWrongKey,
    unsafeUnknownComplete,
    unsafeResurrection,
    unsafeListDelete,
    unsafeRootAccounting
>>

SnapshotVersions ==
    {snapshotRoot[snapshot] : snapshot \in activeSnapshots}

VolumeVersions ==
    {volumeRoot[volume] : volume \in activeVolumes}

ReachableVersions == {headVersion} \cup SnapshotVersions \cup VolumeVersions

LocationVersions(pack) ==
    {version \in usedVersions : coldLocation[version] = pack}

\* pack_records.ref_count is maintained by cold_locations, not by the number
\* of logical roots resolving to a version. Ten clones of one version still
\* own exactly one cold_locations row.
ExpectedRefs(pack) == Cardinality(LocationVersions(pack))

VersionReadable(version) ==
    LET pack == coldLocation[version] IN
    /\ pack # NoPack
    /\ packState[pack] = "Live"
    /\ pack \in cosStored

Init ==
    /\ headVersion = FirstVersion
    /\ usedVersions = {FirstVersion}
    /\ snapshotRoot = [snapshot \in Snapshots |-> NoVersion]
    /\ activeSnapshots = {}
    /\ retiredSnapshots = {}
    /\ volumeRoot = [volume \in Volumes |-> NoVersion]
    /\ activeVolumes = {}
    /\ retiredVolumes = {}
    /\ coldLocation =
           [version \in Versions |->
               IF version = FirstVersion THEN FirstPack ELSE NoPack]
    /\ refCount =
           [pack \in Packs |-> IF pack = FirstPack THEN 1 ELSE 0]
    /\ packState = [pack \in Packs |-> "Live"]
    /\ outbox = [pack \in Packs |-> "None"]
    /\ cosStored = Packs
    /\ unsafeOutbox = FALSE
    /\ unsafeReferencedDelete = FALSE
    /\ unsafeWrongKey = FALSE
    /\ unsafeUnknownComplete = FALSE
    /\ unsafeResurrection = FALSE
    /\ unsafeListDelete = FALSE
    /\ unsafeRootAccounting = FALSE

AdvanceHead(replacement, version) ==
    /\ version \notin usedVersions
    /\ packState[replacement] = "Live"
    /\ replacement \in cosStored
    /\ headVersion' = version
    /\ usedVersions' = usedVersions \cup {version}
    /\ coldLocation' = [coldLocation EXCEPT ![version] = replacement]
    /\ refCount' = [refCount EXCEPT ![replacement] = @ + 1]
    /\ UNCHANGED <<
           snapshotRoot, activeSnapshots, retiredSnapshots, volumeRoot,
           activeVolumes, retiredVolumes, packState, outbox, cosStored,
           unsafeOutbox, unsafeReferencedDelete, unsafeWrongKey,
           unsafeUnknownComplete, unsafeResurrection, unsafeListDelete,
           unsafeRootAccounting
       >>

CreateSnapshot(snapshot) ==
    LET pack == coldLocation[headVersion] IN
    /\ snapshot \notin activeSnapshots \cup retiredSnapshots
    /\ VersionReadable(headVersion)
    /\ snapshotRoot' = [snapshotRoot EXCEPT ![snapshot] = headVersion]
    /\ activeSnapshots' = activeSnapshots \cup {snapshot}
    /\ refCount' =
           IF Mutation = "CountRootAsPackRef"
           THEN [refCount EXCEPT ![pack] = @ + 1]
           ELSE refCount
    /\ unsafeRootAccounting' =
           (unsafeRootAccounting \/ Mutation = "CountRootAsPackRef")
    /\ UNCHANGED <<
           headVersion, usedVersions, retiredSnapshots, volumeRoot,
           activeVolumes, retiredVolumes, coldLocation, packState, outbox,
           cosStored, unsafeOutbox, unsafeReferencedDelete, unsafeWrongKey,
           unsafeUnknownComplete, unsafeResurrection, unsafeListDelete
       >>

DeleteSnapshot(snapshot) ==
    /\ snapshot \in activeSnapshots
    /\ activeSnapshots' = activeSnapshots \ {snapshot}
    /\ retiredSnapshots' = retiredSnapshots \cup {snapshot}
    /\ UNCHANGED <<
           headVersion, usedVersions, snapshotRoot, volumeRoot,
           activeVolumes, retiredVolumes, coldLocation, refCount, packState,
           outbox, cosStored, unsafeOutbox, unsafeReferencedDelete,
           unsafeWrongKey, unsafeUnknownComplete, unsafeResurrection,
           unsafeListDelete, unsafeRootAccounting
       >>

ForkSnapshot(snapshot, volume) ==
    LET version == snapshotRoot[snapshot]
        pack == coldLocation[version]
    IN
    /\ snapshot \in activeSnapshots
    /\ volume \notin activeVolumes \cup retiredVolumes
    /\ \/ packState[pack] = "Live"
       \/ Mutation = "ReferenceDeletingPack"
    /\ volumeRoot' = [volumeRoot EXCEPT ![volume] = version]
    /\ activeVolumes' = activeVolumes \cup {volume}
    /\ unsafeResurrection' =
           (unsafeResurrection \/ packState[pack] # "Live")
    /\ UNCHANGED <<
           headVersion, usedVersions, snapshotRoot, activeSnapshots,
           retiredSnapshots, retiredVolumes, coldLocation, refCount,
           packState, outbox, cosStored, unsafeOutbox,
           unsafeReferencedDelete, unsafeWrongKey, unsafeUnknownComplete,
           unsafeListDelete, unsafeRootAccounting
       >>

DeleteVolume(volume) ==
    /\ volume \in activeVolumes
    /\ activeVolumes' = activeVolumes \ {volume}
    /\ retiredVolumes' = retiredVolumes \cup {volume}
    /\ UNCHANGED <<
           headVersion, usedVersions, snapshotRoot, activeSnapshots,
           retiredSnapshots, volumeRoot, coldLocation, refCount, packState,
           outbox, cosStored, unsafeOutbox, unsafeReferencedDelete,
           unsafeWrongKey, unsafeUnknownComplete, unsafeResurrection,
           unsafeListDelete, unsafeRootAccounting
       >>

\* This is the deliberately wrong root-based implementation. A retry of
\* delete_volume must not decrement a physical pack count because deleting a
\* logical root does not delete the shared cold_locations row.
RetryDeleteVolume(volume) ==
    LET version == volumeRoot[volume]
        pack == coldLocation[version]
    IN
    /\ Mutation = "RetryDoubleVolumeRelease"
    /\ volume \in retiredVolumes
    /\ pack # NoPack
    /\ refCount[pack] > 0
    /\ refCount' = [refCount EXCEPT ![pack] = @ - 1]
    /\ unsafeRootAccounting' = TRUE
    /\ UNCHANGED <<
           headVersion, usedVersions, snapshotRoot, activeSnapshots,
           retiredSnapshots, volumeRoot, activeVolumes, retiredVolumes,
           coldLocation, packState, outbox, cosStored, unsafeOutbox,
           unsafeReferencedDelete, unsafeWrongKey, unsafeUnknownComplete,
           unsafeResurrection, unsafeListDelete
       >>

DropDeadLocation(version) ==
    LET pack == coldLocation[version] IN
    /\ version \in usedVersions
    /\ version \notin ReachableVersions
    /\ pack # NoPack
    /\ coldLocation' = [coldLocation EXCEPT ![version] = NoPack]
    /\ refCount' = [refCount EXCEPT ![pack] = @ - 1]
    /\ UNCHANGED <<
           headVersion, usedVersions, snapshotRoot, activeSnapshots,
           retiredSnapshots, volumeRoot, activeVolumes, retiredVolumes,
           packState, outbox, cosStored, unsafeOutbox,
           unsafeReferencedDelete, unsafeWrongKey, unsafeUnknownComplete,
           unsafeResurrection, unsafeListDelete, unsafeRootAccounting
       >>

BeginGc(pack) ==
    /\ packState[pack] = "Live"
    /\ \/ refCount[pack] = 0
       \/ Mutation = "DeleteReferencedPack"
       \/ Mutation = "ReferenceDeletingPack"
    /\ packState' = [packState EXCEPT ![pack] = "Deleting"]
    /\ outbox' =
           IF Mutation = "GcWithoutOutbox"
           THEN outbox
           ELSE [outbox EXCEPT ![pack] = "Pending"]
    /\ unsafeOutbox' = (unsafeOutbox \/ Mutation = "GcWithoutOutbox")
    /\ unsafeReferencedDelete' =
           (unsafeReferencedDelete \/ refCount[pack] # 0)
    /\ UNCHANGED <<
           headVersion, usedVersions, snapshotRoot, activeSnapshots,
           retiredSnapshots, volumeRoot, activeVolumes, retiredVolumes,
           coldLocation, refCount, cosStored, unsafeWrongKey,
           unsafeUnknownComplete, unsafeResurrection, unsafeListDelete,
           unsafeRootAccounting
       >>

DeleteExactApplied(pack, target) ==
    /\ packState[pack] = "Deleting"
    /\ outbox[pack] = "Pending"
    /\ \/ target = pack
       \/ Mutation = "DeleteWrongExactKey"
    /\ cosStored' = cosStored \ {target}
    /\ unsafeWrongKey' = (unsafeWrongKey \/ target # pack)
    /\ unsafeReferencedDelete' =
           (unsafeReferencedDelete \/ refCount[target] # 0)
    /\ UNCHANGED <<
           headVersion, usedVersions, snapshotRoot, activeSnapshots,
           retiredSnapshots, volumeRoot, activeVolumes, retiredVolumes,
           coldLocation, refCount, packState, outbox, unsafeOutbox,
           unsafeUnknownComplete, unsafeResurrection, unsafeListDelete,
           unsafeRootAccounting
       >>

DeleteUnknownBeforeApply(pack) ==
    /\ packState[pack] = "Deleting"
    /\ outbox[pack] = "Pending"
    /\ pack \in cosStored
    /\ UNCHANGED vars

CompleteGc(pack) ==
    /\ packState[pack] = "Deleting"
    /\ outbox[pack] = "Pending"
    /\ \/ pack \notin cosStored
       \/ Mutation = "CompleteUnknownDelete"
    /\ packState' = [packState EXCEPT ![pack] = "Deleted"]
    /\ outbox' = [outbox EXCEPT ![pack] = "Done"]
    /\ unsafeUnknownComplete' =
           (unsafeUnknownComplete \/ pack \in cosStored)
    /\ UNCHANGED <<
           headVersion, usedVersions, snapshotRoot, activeSnapshots,
           retiredSnapshots, volumeRoot, activeVolumes, retiredVolumes,
           coldLocation, refCount, cosStored, unsafeOutbox,
           unsafeReferencedDelete, unsafeWrongKey, unsafeResurrection,
           unsafeListDelete, unsafeRootAccounting
       >>

DeleteFromList(pack) ==
    /\ Mutation = "ListAuthorizesDelete"
    /\ pack \in cosStored
    /\ cosStored' = cosStored \ {pack}
    /\ unsafeListDelete' = TRUE
    /\ unsafeReferencedDelete' =
           (unsafeReferencedDelete \/ refCount[pack] # 0)
    /\ UNCHANGED <<
           headVersion, usedVersions, snapshotRoot, activeSnapshots,
           retiredSnapshots, volumeRoot, activeVolumes, retiredVolumes,
           coldLocation, refCount, packState, outbox, unsafeOutbox,
           unsafeWrongKey, unsafeUnknownComplete, unsafeResurrection,
           unsafeRootAccounting
       >>

Next ==
    \/ \E replacement \in Packs, version \in Versions :
          AdvanceHead(replacement, version)
    \/ \E snapshot \in Snapshots : CreateSnapshot(snapshot)
    \/ \E snapshot \in Snapshots : DeleteSnapshot(snapshot)
    \/ \E snapshot \in Snapshots, volume \in Volumes :
          ForkSnapshot(snapshot, volume)
    \/ \E volume \in Volumes : DeleteVolume(volume)
    \/ \E volume \in Volumes : RetryDeleteVolume(volume)
    \/ \E version \in Versions : DropDeadLocation(version)
    \/ \E pack \in Packs : BeginGc(pack)
    \/ \E pack \in Packs, target \in Packs : DeleteExactApplied(pack, target)
    \/ \E pack \in Packs : DeleteUnknownBeforeApply(pack)
    \/ \E pack \in Packs : CompleteGc(pack)
    \/ \E pack \in Packs : DeleteFromList(pack)

Spec == Init /\ [][Next]_vars

=====================================================================
