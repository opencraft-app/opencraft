------------------------- MODULE DeltaMapLifecycle -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Volumes, Layers, Snapshots, Blocks, Values, ZeroValue, MaxEpoch,
          Mutation

NoLayer == "NoLayer"
NoVolume == "NoVolume"
NoSnapshot == "NoSnapshot"
NoValue == "NoValue"

LayerStates == {"Free", "Mutable", "Sealed"}

ASSUME /\ Volumes # {}
       /\ Layers # {}
       /\ Snapshots # {}
       /\ Blocks # {}
       /\ Values # {}
       /\ ZeroValue \in Values
       /\ MaxEpoch \in Nat \ {0}
       /\ NoLayer \notin Layers
       /\ NoVolume \notin Volumes
       /\ NoSnapshot \notin Snapshots
       /\ NoValue \notin Values
       /\ Mutation \in {
            "None",
            "RewriteLayerEveryWrite",
            "SnapshotLeavesLayerMutable",
            "MutateSealedLayer",
            "MissingEpochFence",
            "WriteWrongDeltaKey",
            "WriteRetiredVolume",
            "ForkDeletedSnapshot",
            "ReuseDeletedVolume",
            "DeleteSnapshotCascadesVolumes",
            "DeleteVolumeCascadesSnapshots"
          }

InitialVolume == CHOOSE volume \in Volumes : TRUE

VARIABLES
    activeVolumes,
    retiredVolumes,
    epoch,
    currentLayer,
    volumeSourceSnapshot,
    layerState,
    layerParent,
    layerOwner,
    deltaMap,
    logicalImage,
    activeSnapshots,
    retiredSnapshots,
    snapshotLayer,
    snapshotImage,
    snapshotSourceVolume,
    staleMutation,
    sealedMutation,
    steadyPointerRewrite,
    wrongDeltaMutation,
    retiredWriteAccepted,
    deletedSnapshotForked,
    deletedVolumeReused,
    snapshotDeleteDamagedVolume,
    volumeDeleteDamagedSnapshot

vars == <<
    activeVolumes,
    retiredVolumes,
    epoch,
    currentLayer,
    volumeSourceSnapshot,
    layerState,
    layerParent,
    layerOwner,
    deltaMap,
    logicalImage,
    activeSnapshots,
    retiredSnapshots,
    snapshotLayer,
    snapshotImage,
    snapshotSourceVolume,
    staleMutation,
    sealedMutation,
    steadyPointerRewrite,
    wrongDeltaMutation,
    retiredWriteAccepted,
    deletedSnapshotForked,
    deletedVolumeReused,
    snapshotDeleteDamagedVolume,
    volumeDeleteDamagedSnapshot
>>

RECURSIVE Resolve(_, _)
Resolve(layer, block) ==
    IF layer = NoLayer
    THEN ZeroValue
    ELSE IF deltaMap[layer][block] # NoValue
         THEN deltaMap[layer][block]
         ELSE Resolve(layerParent[layer], block)

OtherBlock(block) == CHOOSE other \in Blocks : other # block

Init ==
    /\ activeVolumes = {InitialVolume}
    /\ retiredVolumes = {}
    /\ epoch = [volume \in Volumes |-> IF volume = InitialVolume THEN 1 ELSE 0]
    /\ currentLayer = [volume \in Volumes |-> NoLayer]
    /\ volumeSourceSnapshot = [volume \in Volumes |-> NoSnapshot]
    /\ layerState = [layer \in Layers |-> "Free"]
    /\ layerParent = [layer \in Layers |-> NoLayer]
    /\ layerOwner = [layer \in Layers |-> NoVolume]
    /\ deltaMap = [layer \in Layers |-> [block \in Blocks |-> NoValue]]
    /\ logicalImage =
           [volume \in Volumes |-> [block \in Blocks |-> ZeroValue]]
    /\ activeSnapshots = {}
    /\ retiredSnapshots = {}
    /\ snapshotLayer = [snapshot \in Snapshots |-> NoLayer]
    /\ snapshotImage =
           [snapshot \in Snapshots |-> [block \in Blocks |-> ZeroValue]]
    /\ snapshotSourceVolume = [snapshot \in Snapshots |-> NoVolume]
    /\ staleMutation = FALSE
    /\ sealedMutation = FALSE
    /\ steadyPointerRewrite = FALSE
    /\ wrongDeltaMutation = FALSE
    /\ retiredWriteAccepted = FALSE
    /\ deletedSnapshotForked = FALSE
    /\ deletedVolumeReused = FALSE
    /\ snapshotDeleteDamagedVolume = FALSE
    /\ volumeDeleteDamagedSnapshot = FALSE

WriteIntoFreshLayer(volume, block, value, fresh) ==
    /\ volume \in activeVolumes
    /\ value \in Values
    /\ layerState[fresh] = "Free"
    /\ IF currentLayer[volume] = NoLayer
       THEN TRUE
       ELSE layerState[currentLayer[volume]] = "Sealed"
    /\ layerState' = [layerState EXCEPT ![fresh] = "Mutable"]
    /\ layerParent' = [layerParent EXCEPT ![fresh] = currentLayer[volume]]
    /\ layerOwner' = [layerOwner EXCEPT ![fresh] = volume]
    /\ deltaMap' = [deltaMap EXCEPT ![fresh][block] = value]
    /\ currentLayer' = [currentLayer EXCEPT ![volume] = fresh]
    /\ logicalImage' = [logicalImage EXCEPT ![volume][block] = value]
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, epoch, volumeSourceSnapshot,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume,
           staleMutation, sealedMutation, steadyPointerRewrite,
           wrongDeltaMutation, retiredWriteAccepted, deletedSnapshotForked,
           deletedVolumeReused, snapshotDeleteDamagedVolume,
           volumeDeleteDamagedSnapshot
       >>

WriteIntoMutableLayer(volume, block, value) ==
    LET layer == currentLayer[volume] IN
    /\ volume \in activeVolumes
    /\ value \in Values
    /\ IF layer = NoLayer THEN FALSE ELSE layerState[layer] = "Mutable"
    /\ layerOwner[layer] = volume
    /\ deltaMap' = [deltaMap EXCEPT ![layer][block] = value]
    /\ logicalImage' = [logicalImage EXCEPT ![volume][block] = value]
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, epoch, currentLayer,
           volumeSourceSnapshot, layerState, layerParent, layerOwner,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume,
           staleMutation, sealedMutation, steadyPointerRewrite,
           wrongDeltaMutation, retiredWriteAccepted, deletedSnapshotForked,
           deletedVolumeReused, snapshotDeleteDamagedVolume,
           volumeDeleteDamagedSnapshot
       >>

RewriteMutableLayer(volume, block, value, fresh) ==
    LET old == currentLayer[volume] IN
    /\ Mutation = "RewriteLayerEveryWrite"
    /\ volume \in activeVolumes
    /\ value \in Values
    /\ IF old = NoLayer THEN FALSE ELSE layerState[old] = "Mutable"
    /\ layerOwner[old] = volume
    /\ layerState[fresh] = "Free"
    /\ layerState' =
           [layerState EXCEPT ![old] = "Sealed", ![fresh] = "Mutable"]
    /\ layerParent' = [layerParent EXCEPT ![fresh] = old]
    /\ layerOwner' = [layerOwner EXCEPT ![fresh] = volume]
    /\ deltaMap' = [deltaMap EXCEPT ![fresh][block] = value]
    /\ currentLayer' = [currentLayer EXCEPT ![volume] = fresh]
    /\ logicalImage' = [logicalImage EXCEPT ![volume][block] = value]
    /\ steadyPointerRewrite' = TRUE
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, epoch, volumeSourceSnapshot,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           wrongDeltaMutation, retiredWriteAccepted, deletedSnapshotForked,
           deletedVolumeReused, snapshotDeleteDamagedVolume,
           volumeDeleteDamagedSnapshot
       >>

SnapshotVolume(volume, snapshot) ==
    LET layer == currentLayer[volume] IN
    /\ volume \in activeVolumes
    /\ snapshot \notin activeSnapshots \cup retiredSnapshots
    /\ epoch[volume] < MaxEpoch
    /\ activeSnapshots' = activeSnapshots \cup {snapshot}
    /\ snapshotLayer' = [snapshotLayer EXCEPT ![snapshot] = layer]
    /\ snapshotImage' = [snapshotImage EXCEPT ![snapshot] = logicalImage[volume]]
    /\ snapshotSourceVolume' =
           [snapshotSourceVolume EXCEPT ![snapshot] = volume]
    /\ epoch' = [epoch EXCEPT ![volume] = @ + 1]
    /\ layerState' =
           IF layer = NoLayer
           THEN layerState
           ELSE IF layerState[layer] = "Mutable"
                THEN IF Mutation = "SnapshotLeavesLayerMutable"
                     THEN layerState
                     ELSE [layerState EXCEPT ![layer] = "Sealed"]
                ELSE layerState
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, currentLayer, volumeSourceSnapshot,
           layerParent, layerOwner, deltaMap, logicalImage, retiredSnapshots,
           staleMutation, sealedMutation, steadyPointerRewrite,
           wrongDeltaMutation, retiredWriteAccepted, deletedSnapshotForked,
           deletedVolumeReused, snapshotDeleteDamagedVolume,
           volumeDeleteDamagedSnapshot
       >>

ForkSnapshot(snapshot, child) ==
    /\ snapshot \in activeSnapshots
    /\ child \notin activeVolumes \cup retiredVolumes
    /\ activeVolumes' = activeVolumes \cup {child}
    /\ epoch' = [epoch EXCEPT ![child] = 1]
    /\ currentLayer' = [currentLayer EXCEPT ![child] = snapshotLayer[snapshot]]
    /\ volumeSourceSnapshot' =
           [volumeSourceSnapshot EXCEPT ![child] = snapshot]
    /\ logicalImage' = [logicalImage EXCEPT ![child] = snapshotImage[snapshot]]
    /\ UNCHANGED <<
           retiredVolumes, layerState, layerParent, layerOwner, deltaMap,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           steadyPointerRewrite, wrongDeltaMutation, retiredWriteAccepted,
           deletedSnapshotForked, deletedVolumeReused,
           snapshotDeleteDamagedVolume, volumeDeleteDamagedSnapshot
       >>

\* A snapshot is an independently pinned immutable root. Deleting its name
\* prevents future forks but cannot retire children that already forked it.
DeleteSnapshot(snapshot) ==
    /\ snapshot \in activeSnapshots
    /\ activeSnapshots' = activeSnapshots \ {snapshot}
    /\ retiredSnapshots' = retiredSnapshots \cup {snapshot}
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, epoch, currentLayer,
           volumeSourceSnapshot, layerState, layerParent, layerOwner,
           deltaMap, logicalImage, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           steadyPointerRewrite, wrongDeltaMutation, retiredWriteAccepted,
           deletedSnapshotForked, deletedVolumeReused,
           snapshotDeleteDamagedVolume, volumeDeleteDamagedSnapshot
       >>

\* A volume is a mutable GC root owned by one sandbox. Its tombstone retains
\* the old root and lineage for retry/audit, but only activeVolumes contributes
\* reachability. A private mutable tip is sealed so no writer can retain it.
DeleteVolume(volume) ==
    LET layer == currentLayer[volume] IN
    /\ volume \in activeVolumes
    /\ activeVolumes' = activeVolumes \ {volume}
    /\ retiredVolumes' = retiredVolumes \cup {volume}
    /\ layerState' =
           IF layer # NoLayer /\ layerState[layer] = "Mutable"
           THEN [layerState EXCEPT ![layer] = "Sealed"]
           ELSE layerState
    /\ UNCHANGED <<
           epoch, currentLayer, volumeSourceSnapshot, layerParent, layerOwner,
           deltaMap, logicalImage, activeSnapshots, retiredSnapshots,
           snapshotLayer, snapshotImage, snapshotSourceVolume, staleMutation,
           sealedMutation, steadyPointerRewrite, wrongDeltaMutation,
           retiredWriteAccepted, deletedSnapshotForked, deletedVolumeReused,
           snapshotDeleteDamagedVolume, volumeDeleteDamagedSnapshot
       >>

\* Fault branches below make the lifecycle policies executable obligations.
WriteRetiredVolume(volume, block, value) ==
    LET layer == currentLayer[volume] IN
    /\ Mutation = "WriteRetiredVolume"
    /\ volume \in retiredVolumes
    /\ layer # NoLayer
    /\ value \in Values
    /\ deltaMap' = [deltaMap EXCEPT ![layer][block] = value]
    /\ logicalImage' = [logicalImage EXCEPT ![volume][block] = value]
    /\ retiredWriteAccepted' = TRUE
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, epoch, currentLayer,
           volumeSourceSnapshot, layerState, layerParent, layerOwner,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           steadyPointerRewrite, wrongDeltaMutation, deletedSnapshotForked,
           deletedVolumeReused, snapshotDeleteDamagedVolume,
           volumeDeleteDamagedSnapshot
       >>

ForkDeletedSnapshot(snapshot, child) ==
    /\ Mutation = "ForkDeletedSnapshot"
    /\ snapshot \in retiredSnapshots
    /\ child \notin activeVolumes \cup retiredVolumes
    /\ activeVolumes' = activeVolumes \cup {child}
    /\ epoch' = [epoch EXCEPT ![child] = 1]
    /\ currentLayer' = [currentLayer EXCEPT ![child] = snapshotLayer[snapshot]]
    /\ volumeSourceSnapshot' =
           [volumeSourceSnapshot EXCEPT ![child] = snapshot]
    /\ logicalImage' = [logicalImage EXCEPT ![child] = snapshotImage[snapshot]]
    /\ deletedSnapshotForked' = TRUE
    /\ UNCHANGED <<
           retiredVolumes, layerState, layerParent, layerOwner, deltaMap,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           steadyPointerRewrite, wrongDeltaMutation, retiredWriteAccepted,
           deletedVolumeReused, snapshotDeleteDamagedVolume,
           volumeDeleteDamagedSnapshot
       >>

ReuseDeletedVolume(snapshot, child) ==
    /\ Mutation = "ReuseDeletedVolume"
    /\ snapshot \in activeSnapshots
    /\ child \in retiredVolumes
    /\ activeVolumes' = activeVolumes \cup {child}
    /\ retiredVolumes' = retiredVolumes \ {child}
    /\ epoch' =
           [epoch EXCEPT
                ![child] = IF @ < MaxEpoch THEN @ + 1 ELSE 1]
    /\ currentLayer' = [currentLayer EXCEPT ![child] = snapshotLayer[snapshot]]
    /\ volumeSourceSnapshot' =
           [volumeSourceSnapshot EXCEPT ![child] = snapshot]
    /\ logicalImage' = [logicalImage EXCEPT ![child] = snapshotImage[snapshot]]
    /\ deletedVolumeReused' = TRUE
    /\ UNCHANGED <<
           layerState, layerParent, layerOwner, deltaMap, activeSnapshots,
           retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           steadyPointerRewrite, wrongDeltaMutation, retiredWriteAccepted,
           deletedSnapshotForked, snapshotDeleteDamagedVolume,
           volumeDeleteDamagedSnapshot
       >>

DeleteSnapshotAndForks(snapshot) ==
    LET victims ==
        {volume \in activeVolumes : volumeSourceSnapshot[volume] = snapshot}
    IN
    /\ Mutation = "DeleteSnapshotCascadesVolumes"
    /\ snapshot \in activeSnapshots
    /\ victims # {}
    /\ activeVolumes' = activeVolumes \ victims
    /\ retiredVolumes' = retiredVolumes \cup victims
    /\ activeSnapshots' = activeSnapshots \ {snapshot}
    /\ retiredSnapshots' = retiredSnapshots \cup {snapshot}
    /\ layerState' =
           [layer \in Layers |->
               IF layerState[layer] = "Mutable"
                  /\ layerOwner[layer] \in victims
               THEN "Sealed"
               ELSE layerState[layer]]
    /\ snapshotDeleteDamagedVolume' = TRUE
    /\ UNCHANGED <<
           epoch, currentLayer, volumeSourceSnapshot, layerParent, layerOwner,
           deltaMap, logicalImage, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           steadyPointerRewrite, wrongDeltaMutation, retiredWriteAccepted,
           deletedSnapshotForked, deletedVolumeReused,
           volumeDeleteDamagedSnapshot
       >>

DeleteVolumeAndSnapshots(volume) ==
    LET layer == currentLayer[volume]
        victims ==
            {snapshot \in activeSnapshots :
                snapshotSourceVolume[snapshot] = volume}
    IN
    /\ Mutation = "DeleteVolumeCascadesSnapshots"
    /\ volume \in activeVolumes
    /\ victims # {}
    /\ activeVolumes' = activeVolumes \ {volume}
    /\ retiredVolumes' = retiredVolumes \cup {volume}
    /\ activeSnapshots' = activeSnapshots \ victims
    /\ retiredSnapshots' = retiredSnapshots \cup victims
    /\ layerState' =
           IF layer # NoLayer /\ layerState[layer] = "Mutable"
           THEN [layerState EXCEPT ![layer] = "Sealed"]
           ELSE layerState
    /\ volumeDeleteDamagedSnapshot' = TRUE
    /\ UNCHANGED <<
           epoch, currentLayer, volumeSourceSnapshot, layerParent, layerOwner,
           deltaMap, logicalImage, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           steadyPointerRewrite, wrongDeltaMutation, retiredWriteAccepted,
           deletedSnapshotForked, deletedVolumeReused,
           snapshotDeleteDamagedVolume
       >>

RecoverWriter(volume) ==
    /\ volume \in activeVolumes
    /\ epoch[volume] < MaxEpoch
    /\ epoch' = [epoch EXCEPT ![volume] = @ + 1]
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, currentLayer, volumeSourceSnapshot,
           layerState, layerParent, layerOwner, deltaMap, logicalImage,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           steadyPointerRewrite, wrongDeltaMutation, retiredWriteAccepted,
           deletedSnapshotForked, deletedVolumeReused,
           snapshotDeleteDamagedVolume, volumeDeleteDamagedSnapshot
       >>

MutateSealed(volume, block, value) ==
    LET layer == currentLayer[volume] IN
    /\ Mutation = "MutateSealedLayer"
    /\ volume \in activeVolumes
    /\ value \in Values
    /\ IF layer = NoLayer THEN FALSE ELSE layerState[layer] = "Sealed"
    /\ deltaMap' = [deltaMap EXCEPT ![layer][block] = value]
    /\ logicalImage' = [logicalImage EXCEPT ![volume][block] = value]
    /\ sealedMutation' = TRUE
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, epoch, currentLayer,
           volumeSourceSnapshot, layerState, layerParent, layerOwner,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, steadyPointerRewrite,
           wrongDeltaMutation, retiredWriteAccepted, deletedSnapshotForked,
           deletedVolumeReused, snapshotDeleteDamagedVolume,
           volumeDeleteDamagedSnapshot
       >>

CommitStaleWriter(volume, block, value) ==
    LET layer == currentLayer[volume] IN
    /\ Mutation = "MissingEpochFence"
    /\ volume \in activeVolumes
    /\ epoch[volume] > 1
    /\ value \in Values
    /\ IF layer = NoLayer THEN FALSE ELSE layerState[layer] = "Mutable"
    /\ deltaMap' = [deltaMap EXCEPT ![layer][block] = value]
    /\ logicalImage' = [logicalImage EXCEPT ![volume][block] = value]
    /\ staleMutation' = TRUE
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, epoch, currentLayer,
           volumeSourceSnapshot, layerState, layerParent, layerOwner,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume, sealedMutation, steadyPointerRewrite,
           wrongDeltaMutation, retiredWriteAccepted, deletedSnapshotForked,
           deletedVolumeReused, snapshotDeleteDamagedVolume,
           volumeDeleteDamagedSnapshot
       >>

WriteWrongKey(volume, block, value) ==
    LET layer == currentLayer[volume]
        wrong == OtherBlock(block)
    IN
    /\ Mutation = "WriteWrongDeltaKey"
    /\ Cardinality(Blocks) > 1
    /\ volume \in activeVolumes
    /\ value \in Values
    /\ IF layer = NoLayer THEN FALSE ELSE layerState[layer] = "Mutable"
    /\ deltaMap' = [deltaMap EXCEPT ![layer][wrong] = value]
    /\ logicalImage' = [logicalImage EXCEPT ![volume][block] = value]
    /\ wrongDeltaMutation' = TRUE
    /\ UNCHANGED <<
           activeVolumes, retiredVolumes, epoch, currentLayer,
           volumeSourceSnapshot, layerState, layerParent, layerOwner,
           activeSnapshots, retiredSnapshots, snapshotLayer, snapshotImage,
           snapshotSourceVolume, staleMutation, sealedMutation,
           steadyPointerRewrite, retiredWriteAccepted,
           deletedSnapshotForked, deletedVolumeReused,
           snapshotDeleteDamagedVolume, volumeDeleteDamagedSnapshot
       >>

Next ==
    \/ \E volume \in Volumes, block \in Blocks, value \in Values,
          fresh \in Layers : WriteIntoFreshLayer(volume, block, value, fresh)
    \/ \E volume \in Volumes, block \in Blocks, value \in Values :
          WriteIntoMutableLayer(volume, block, value)
    \/ \E volume \in Volumes, block \in Blocks, value \in Values,
          fresh \in Layers : RewriteMutableLayer(volume, block, value, fresh)
    \/ \E volume \in Volumes, snapshot \in Snapshots :
          SnapshotVolume(volume, snapshot)
    \/ \E snapshot \in Snapshots, child \in Volumes :
          ForkSnapshot(snapshot, child)
    \/ \E snapshot \in Snapshots : DeleteSnapshot(snapshot)
    \/ \E volume \in Volumes : DeleteVolume(volume)
    \/ \E volume \in Volumes : RecoverWriter(volume)
    \/ \E volume \in Volumes, block \in Blocks, value \in Values :
          MutateSealed(volume, block, value)
    \/ \E volume \in Volumes, block \in Blocks, value \in Values :
          CommitStaleWriter(volume, block, value)
    \/ \E volume \in Volumes, block \in Blocks, value \in Values :
          WriteWrongKey(volume, block, value)
    \/ \E volume \in Volumes, block \in Blocks, value \in Values :
          WriteRetiredVolume(volume, block, value)
    \/ \E snapshot \in Snapshots, child \in Volumes :
          ForkDeletedSnapshot(snapshot, child)
    \/ \E snapshot \in Snapshots, child \in Volumes :
          ReuseDeletedVolume(snapshot, child)
    \/ \E snapshot \in Snapshots : DeleteSnapshotAndForks(snapshot)
    \/ \E volume \in Volumes : DeleteVolumeAndSnapshots(volume)

Spec == Init /\ [][Next]_vars

=============================================================================
