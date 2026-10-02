---------------------- MODULE DeltaMapLifecycleSafety ----------------------
EXTENDS DeltaMapLifecycle

LayerTypeOK(layer) ==
    /\ layerState[layer] \in LayerStates
    /\ layerParent[layer] \in Layers \cup {NoLayer}
    /\ layerOwner[layer] \in Volumes \cup {NoVolume}
    /\ deltaMap[layer] \in [Blocks -> Values \cup {NoValue}]
    /\ IF layerState[layer] = "Free"
       THEN /\ layerParent[layer] = NoLayer
            /\ layerOwner[layer] = NoVolume
            /\ deltaMap[layer] = [block \in Blocks |-> NoValue]
       ELSE TRUE
    /\ IF layerState[layer] = "Mutable"
       THEN layerOwner[layer] \in activeVolumes
       ELSE TRUE

TypeOK ==
    /\ activeVolumes \subseteq Volumes
    /\ retiredVolumes \subseteq Volumes
    /\ activeVolumes \cap retiredVolumes = {}
    /\ InitialVolume \in activeVolumes \cup retiredVolumes
    /\ epoch \in [Volumes -> 0..MaxEpoch]
    /\ currentLayer \in [Volumes -> Layers \cup {NoLayer}]
    /\ volumeSourceSnapshot \in
           [Volumes -> Snapshots \cup {NoSnapshot}]
    /\ \A volume \in activeVolumes : epoch[volume] \in 1..MaxEpoch
    /\ \A volume \in retiredVolumes : epoch[volume] \in 1..MaxEpoch
    /\ \A volume \in Volumes \ (activeVolumes \cup retiredVolumes) :
           /\ epoch[volume] = 0
           /\ currentLayer[volume] = NoLayer
           /\ volumeSourceSnapshot[volume] = NoSnapshot
    /\ \A volume \in activeVolumes \cup retiredVolumes :
           volumeSourceSnapshot[volume] # NoSnapshot =>
               volumeSourceSnapshot[volume] \in
                   activeSnapshots \cup retiredSnapshots
    /\ \A layer \in Layers : LayerTypeOK(layer)
    /\ logicalImage \in [Volumes -> [Blocks -> Values]]
    /\ activeSnapshots \subseteq Snapshots
    /\ retiredSnapshots \subseteq Snapshots
    /\ activeSnapshots \cap retiredSnapshots = {}
    /\ snapshotLayer \in [Snapshots -> Layers \cup {NoLayer}]
    /\ snapshotImage \in [Snapshots -> [Blocks -> Values]]
    /\ snapshotSourceVolume \in
           [Snapshots -> Volumes \cup {NoVolume}]
    /\ \A snapshot \in Snapshots \
                      (activeSnapshots \cup retiredSnapshots) :
           /\ snapshotLayer[snapshot] = NoLayer
           /\ snapshotSourceVolume[snapshot] = NoVolume
    /\ \A snapshot \in activeSnapshots \cup retiredSnapshots :
           snapshotSourceVolume[snapshot] \in
               activeVolumes \cup retiredVolumes
    /\ staleMutation \in BOOLEAN
    /\ sealedMutation \in BOOLEAN
    /\ steadyPointerRewrite \in BOOLEAN
    /\ wrongDeltaMutation \in BOOLEAN
    /\ retiredWriteAccepted \in BOOLEAN
    /\ deletedSnapshotForked \in BOOLEAN
    /\ deletedVolumeReused \in BOOLEAN
    /\ snapshotDeleteDamagedVolume \in BOOLEAN
    /\ volumeDeleteDamagedSnapshot \in BOOLEAN

LayerParentsAreSealed ==
    \A layer \in Layers :
        IF layerState[layer] = "Free" \/ layerParent[layer] = NoLayer
        THEN TRUE
        ELSE layerState[layerParent[layer]] = "Sealed"

MutableLayersAreExclusive ==
    \A layer \in Layers :
        layerState[layer] = "Mutable" =>
            /\ Cardinality({volume \in activeVolumes : currentLayer[volume] = layer}) = 1
            /\ layerOwner[layer] \in activeVolumes
            /\ currentLayer[layerOwner[layer]] = layer
            /\ \A snapshot \in activeSnapshots : snapshotLayer[snapshot] # layer

VolumeReadsMatchOracle ==
    \A volume \in activeVolumes, block \in Blocks :
        Resolve(currentLayer[volume], block) = logicalImage[volume][block]

SnapshotsImmutable ==
    /\ ~sealedMutation
    /\ \A snapshot \in activeSnapshots, block \in Blocks :
           Resolve(snapshotLayer[snapshot], block) = snapshotImage[snapshot][block]
    /\ \A snapshot \in activeSnapshots :
           IF snapshotLayer[snapshot] = NoLayer
           THEN TRUE
           ELSE layerState[snapshotLayer[snapshot]] = "Sealed"

StaleEpochsFenced == ~staleMutation

SteadyWritesKeepLayerPointer == ~steadyPointerRewrite

WritesChangeOnlyAddressedDelta == ~wrongDeltaMutation

RetiredVolumesAreFenced == ~retiredWriteAccepted

DeletedSnapshotsCannotFork == ~deletedSnapshotForked

DeletedVolumeIncarnationsNeverReused == ~deletedVolumeReused

SnapshotDeletionPreservesForks == ~snapshotDeleteDamagedVolume

VolumeDeletionPreservesSnapshots == ~volumeDeleteDamagedSnapshot

Safety ==
    /\ TypeOK
    /\ LayerParentsAreSealed
    /\ MutableLayersAreExclusive
    /\ VolumeReadsMatchOracle
    /\ SnapshotsImmutable
    /\ StaleEpochsFenced
    /\ SteadyWritesKeepLayerPointer
    /\ WritesChangeOnlyAddressedDelta
    /\ RetiredVolumesAreFenced
    /\ DeletedSnapshotsCannotFork
    /\ DeletedVolumeIncarnationsNeverReused
    /\ SnapshotDeletionPreservesForks
    /\ VolumeDeletionPreservesSnapshots

=============================================================================
