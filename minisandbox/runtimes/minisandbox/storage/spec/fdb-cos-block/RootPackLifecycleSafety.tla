--------------------- MODULE RootPackLifecycleSafety ---------------------
EXTENDS RootPackLifecycle

ReferencedRootsOracle ==
    {layerRoot[layer] :
        layer \in {candidate \in activeLayers :
            layerRoot[candidate] # NoRoot}}
    \cup
    {snapshotRoot[snapshot] :
        snapshot \in {candidate \in snapshotUsed :
            snapshotRoot[candidate] # NoRoot}}

ReferencedObjectsOracle ==
    UNION {ObjectsIn(rootImage[root]) : root \in ReferencedRootsOracle}

OracleDurableCopyExists(object) ==
    \/ object \in hot
    \/ LET pack == location[object] IN
       /\ pack # NoPack
       /\ pack \in cosPacks
       /\ pack \in verifiedPacks
       /\ object \in packMembers[pack]

TypeOK ==
    /\ nextVersion \in 1..(MaxVersion + 1)
    /\ issued \subseteq Objects
    /\ activeLayers \subseteq Layers
    /\ retiredLayers \subseteq Layers
    /\ activeLayers \cap retiredLayers = {}
    /\ layerRoot \in [Layers -> Roots \cup {NoRoot}]
    /\ snapshotRoot \in [Snapshots -> Roots \cup {NoRoot}]
    /\ snapshotUsed \subseteq Snapshots
    /\ retiredSnapshots \subseteq Snapshots
    /\ snapshotUsed \cap retiredSnapshots = {}
    /\ publishedRoots \subseteq Roots
    /\ rootParent \in [Roots -> Roots \cup {NoRoot}]
    /\ rootImage \in [Roots -> Images]
    /\ hot \subseteq issued
    /\ builtPacks \subseteq Packs
    /\ packMembers \in [Packs -> SUBSET issued]
    /\ cosPacks \subseteq builtPacks
    /\ verifiedPacks \subseteq cosPacks
    /\ location \in [Objects -> Packs \cup {NoPack}]
    /\ unsafePublish \in BOOLEAN
    /\ unsafeDelete \in BOOLEAN
    /\ unsafeEvict \in BOOLEAN
    /\ unsafeRewrite \in BOOLEAN
    /\ unsafeRepackGap \in BOOLEAN

RetiredLayerIdsNeverReused == activeLayers \cap retiredLayers = {}

RetiredSnapshotIdsNeverReused == snapshotUsed \cap retiredSnapshots = {}

RootPointersAuthentic ==
    /\ \A layer \in activeLayers :
           layerRoot[layer] = NoRoot \/ layerRoot[layer] \in publishedRoots
    /\ \A snapshot \in snapshotUsed :
           snapshotRoot[snapshot] \in publishedRoots
    /\ \A root \in publishedRoots :
           /\ ImageTypeOK(rootImage[root])
           /\ ObjectsIn(rootImage[root]) \subseteq issued
           /\ rootParent[root] = NoRoot \/ rootParent[root] \in publishedRoots

LocationsAuthentic ==
    \A object \in issued :
        location[object] # NoPack
        => LET pack == location[object] IN
           /\ pack \in cosPacks
           /\ pack \in verifiedPacks
           /\ object \in packMembers[pack]

AllReferencedRootDataRecoverable ==
    \A object \in ReferencedObjectsOracle : OracleDurableCopyExists(object)

NoUnverifiedPublication == ~unsafePublish
NoReferencedPackDeletion == ~unsafeDelete
NoUnsafeHotEviction == ~unsafeEvict
PackMembershipImmutable == ~unsafeRewrite
RepackIsGapFree == ~unsafeRepackGap

Safety ==
    /\ TypeOK
    /\ RootPointersAuthentic
    /\ LocationsAuthentic
    /\ AllReferencedRootDataRecoverable
    /\ NoUnverifiedPublication
    /\ NoReferencedPackDeletion
    /\ NoUnsafeHotEviction
    /\ PackMembershipImmutable
    /\ RepackIsGapFree
    /\ RetiredLayerIdsNeverReused
    /\ RetiredSnapshotIdsNeverReused

=============================================================================
