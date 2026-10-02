------------------------ MODULE RootPackLifecycle ------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Blocks, Values, Roots, Layers, Snapshots, Packs, MaxVersion, Mutation

NoObj == [block |-> "NoBlock", version |-> 0, value |-> "NoValue"]
NoRoot == "NoRoot"
NoPack == "NoPack"

ASSUME /\ Blocks # {}
       /\ Values # {}
       /\ Roots # {}
       /\ Layers # {}
       /\ Snapshots # {}
       /\ Packs # {}
       /\ NoRoot \notin Roots
       /\ NoPack \notin Packs
       /\ MaxVersion \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "IgnoreForkRoot",
            "PublishUnverifiedPack",
            "DeleteReferencedPack",
            "EvictBeforePackPublish",
            "RewriteImmutablePack",
            "RepackGap",
            "ReuseDeletedLayer",
            "ReuseDeletedSnapshot"
          }

Obj(block, version, value) ==
    [block |-> block, version |-> version, value |-> value]

Objects ==
    {Obj(block, version, value) :
        block \in Blocks, version \in 1..MaxVersion, value \in Values}

ObjectUniverse == Objects \cup {NoObj}
EmptyImage == [block \in Blocks |-> NoObj]
Images == [Blocks -> ObjectUniverse]

ImageTypeOK(image) ==
    /\ image \in Images
    /\ \A block \in Blocks :
           \/ image[block] = NoObj
           \/ image[block].block = block

ObjectsIn(image) == {image[block] : block \in Blocks} \ {NoObj}

InitialLayer == CHOOSE layer \in Layers : TRUE

VARIABLES
    nextVersion,
    issued,
    activeLayers,
    retiredLayers,
    layerRoot,
    snapshotRoot,
    snapshotUsed,
    retiredSnapshots,
    publishedRoots,
    rootParent,
    rootImage,
    hot,
    builtPacks,
    packMembers,
    cosPacks,
    verifiedPacks,
    location,
    unsafePublish,
    unsafeDelete,
    unsafeEvict,
    unsafeRewrite,
    unsafeRepackGap

vars == <<
    nextVersion,
    issued,
    activeLayers,
    retiredLayers,
    layerRoot,
    snapshotRoot,
    snapshotUsed,
    retiredSnapshots,
    publishedRoots,
    rootParent,
    rootImage,
    hot,
    builtPacks,
    packMembers,
    cosPacks,
    verifiedPacks,
    location,
    unsafePublish,
    unsafeDelete,
    unsafeEvict,
    unsafeRewrite,
    unsafeRepackGap
>>

ColdStored(object) ==
    LET pack == location[object] IN
    /\ pack # NoPack
    /\ pack \in cosPacks
    /\ pack \in verifiedPacks
    /\ object \in packMembers[pack]

ObjectStored(object) == object \in hot \/ ColdStored(object)

GcLayerSet ==
    IF Mutation = "IgnoreForkRoot"
    THEN activeLayers \cap {InitialLayer}
    ELSE activeLayers

GcReferencedRoots ==
    {layerRoot[layer] :
        layer \in {candidate \in GcLayerSet : layerRoot[candidate] # NoRoot}}
    \cup
    {snapshotRoot[snapshot] :
        snapshot \in {candidate \in snapshotUsed :
            snapshotRoot[candidate] # NoRoot}}

GcLiveObjects ==
    UNION {ObjectsIn(rootImage[root]) : root \in GcReferencedRoots}

Init ==
    /\ nextVersion = 1
    /\ issued = {}
    /\ activeLayers = {InitialLayer}
    /\ retiredLayers = {}
    /\ layerRoot = [layer \in Layers |-> NoRoot]
    /\ snapshotRoot = [snapshot \in Snapshots |-> NoRoot]
    /\ snapshotUsed = {}
    /\ retiredSnapshots = {}
    /\ publishedRoots = {}
    /\ rootParent = [root \in Roots |-> NoRoot]
    /\ rootImage = [root \in Roots |-> EmptyImage]
    /\ hot = {}
    /\ builtPacks = {}
    /\ packMembers = [pack \in Packs |-> {}]
    /\ cosPacks = {}
    /\ verifiedPacks = {}
    /\ location = [object \in Objects |-> NoPack]
    /\ unsafePublish = FALSE
    /\ unsafeDelete = FALSE
    /\ unsafeEvict = FALSE
    /\ unsafeRewrite = FALSE
    /\ unsafeRepackGap = FALSE

WriteAndPublishRoot(layer, root, block, value) ==
    LET parent == layerRoot[layer]
        base == IF parent = NoRoot THEN EmptyImage ELSE rootImage[parent]
        object == Obj(block, nextVersion, value)
        image == [base EXCEPT ![block] = object]
    IN
    /\ layer \in activeLayers
    /\ root \notin publishedRoots
    /\ nextVersion <= MaxVersion
    /\ publishedRoots' = publishedRoots \cup {root}
    /\ rootParent' = [rootParent EXCEPT ![root] = parent]
    /\ rootImage' = [rootImage EXCEPT ![root] = image]
    /\ layerRoot' = [layerRoot EXCEPT ![layer] = root]
    /\ issued' = issued \cup {object}
    /\ hot' = hot \cup {object}
    /\ nextVersion' = nextVersion + 1
    /\ UNCHANGED <<
           activeLayers, retiredLayers, snapshotRoot, snapshotUsed,
           retiredSnapshots, builtPacks,
           packMembers, cosPacks, verifiedPacks, location, unsafePublish,
           unsafeDelete, unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

CreateSnapshot(layer, snapshot) ==
    /\ layer \in activeLayers
    /\ layerRoot[layer] # NoRoot
    /\ snapshot \notin snapshotUsed \cup retiredSnapshots
    /\ snapshotRoot' = [snapshotRoot EXCEPT ![snapshot] = layerRoot[layer]]
    /\ snapshotUsed' = snapshotUsed \cup {snapshot}
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot, builtPacks, packMembers, cosPacks,
           verifiedPacks, location, unsafePublish, unsafeDelete, unsafeEvict,
           unsafeRewrite, unsafeRepackGap
       >>

DeleteSnapshot(snapshot) ==
    /\ snapshot \in snapshotUsed
    /\ snapshotRoot' = [snapshotRoot EXCEPT ![snapshot] = NoRoot]
    /\ snapshotUsed' = snapshotUsed \ {snapshot}
    /\ retiredSnapshots' = retiredSnapshots \cup {snapshot}
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           publishedRoots,
           rootParent, rootImage, hot, builtPacks, packMembers, cosPacks,
           verifiedPacks, location, unsafePublish, unsafeDelete, unsafeEvict,
           unsafeRewrite, unsafeRepackGap
       >>

ForkLayer(source, child) ==
    /\ source \in activeLayers
    /\ child \notin activeLayers \cup retiredLayers
    /\ layerRoot[source] # NoRoot
    /\ activeLayers' = activeLayers \cup {child}
    /\ layerRoot' = [layerRoot EXCEPT ![child] = layerRoot[source]]
    /\ UNCHANGED <<
           nextVersion, issued, retiredLayers, snapshotRoot, snapshotUsed,
           retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot, builtPacks, packMembers, cosPacks,
           verifiedPacks, location, unsafePublish, unsafeDelete, unsafeEvict,
           unsafeRewrite, unsafeRepackGap
       >>

DeleteLayer(layer) ==
    /\ layer \in activeLayers
    /\ activeLayers' = activeLayers \ {layer}
    /\ retiredLayers' = retiredLayers \cup {layer}
    /\ layerRoot' = [layerRoot EXCEPT ![layer] = NoRoot]
    /\ UNCHANGED <<
           nextVersion, issued, snapshotRoot, snapshotUsed, retiredSnapshots,
           publishedRoots,
           rootParent, rootImage, hot, builtPacks, packMembers, cosPacks,
           verifiedPacks, location, unsafePublish, unsafeDelete, unsafeEvict,
           unsafeRewrite, unsafeRepackGap
       >>

ReuseDeletedLayer(source, child) ==
    /\ Mutation = "ReuseDeletedLayer"
    /\ source \in activeLayers
    /\ child \in retiredLayers
    /\ layerRoot[source] # NoRoot
    /\ activeLayers' = activeLayers \cup {child}
    /\ layerRoot' = [layerRoot EXCEPT ![child] = layerRoot[source]]
    /\ UNCHANGED <<
           nextVersion, issued, retiredLayers, snapshotRoot, snapshotUsed,
           retiredSnapshots, publishedRoots, rootParent, rootImage, hot,
           builtPacks, packMembers, cosPacks, verifiedPacks, location,
           unsafePublish, unsafeDelete, unsafeEvict, unsafeRewrite,
           unsafeRepackGap
       >>

ReuseDeletedSnapshot(layer, snapshot) ==
    /\ Mutation = "ReuseDeletedSnapshot"
    /\ layer \in activeLayers
    /\ layerRoot[layer] # NoRoot
    /\ snapshot \in retiredSnapshots
    /\ snapshotRoot' = [snapshotRoot EXCEPT ![snapshot] = layerRoot[layer]]
    /\ snapshotUsed' = snapshotUsed \cup {snapshot}
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           retiredSnapshots, publishedRoots, rootParent, rootImage, hot,
           builtPacks, packMembers, cosPacks, verifiedPacks, location,
           unsafePublish, unsafeDelete, unsafeEvict, unsafeRewrite,
           unsafeRepackGap
       >>

BuildPack(pack, members) ==
    /\ pack \notin builtPacks
    /\ members \in SUBSET issued
    /\ members # {}
    /\ \A object \in members : ObjectStored(object)
    /\ builtPacks' = builtPacks \cup {pack}
    /\ packMembers' = [packMembers EXCEPT ![pack] = members]
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           snapshotRoot, snapshotUsed, retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot,
           cosPacks, verifiedPacks, location, unsafePublish, unsafeDelete,
           unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

PutPack(pack) ==
    /\ pack \in builtPacks
    /\ pack \notin cosPacks
    /\ cosPacks' = cosPacks \cup {pack}
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           snapshotRoot, snapshotUsed, retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot,
           builtPacks, packMembers, verifiedPacks, location, unsafePublish,
           unsafeDelete, unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

VerifyPack(pack) ==
    /\ pack \in cosPacks
    /\ pack \notin verifiedPacks
    /\ verifiedPacks' = verifiedPacks \cup {pack}
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           snapshotRoot, snapshotUsed, retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot,
           builtPacks, packMembers, cosPacks, location, unsafePublish,
           unsafeDelete, unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

PublishMember(pack, object) ==
    /\ pack \in builtPacks
    /\ object \in packMembers[pack]
    /\ object \in GcLiveObjects
    /\ location[object] # pack
    /\ \/ /\ pack \in cosPacks
           /\ pack \in verifiedPacks
       \/ Mutation = "PublishUnverifiedPack"
    /\ location' = [location EXCEPT ![object] = pack]
    /\ unsafePublish' =
           (unsafePublish \/
            ~(pack \in cosPacks /\ pack \in verifiedPacks))
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           snapshotRoot, snapshotUsed, retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot,
           builtPacks, packMembers, cosPacks, verifiedPacks, unsafeDelete,
           unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

DropDeadLocation(object) ==
    /\ object \in issued
    /\ object \notin GcLiveObjects
    /\ location[object] # NoPack
    /\ location' = [location EXCEPT ![object] = NoPack]
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           snapshotRoot, snapshotUsed, retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot,
           builtPacks, packMembers, cosPacks, verifiedPacks, unsafePublish,
           unsafeDelete, unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

HotEvictionSafe(object) ==
    \/ object \notin GcLiveObjects
    \/ ColdStored(object)

DropHot(object) ==
    /\ object \in hot
    /\ \/ HotEvictionSafe(object)
       \/ Mutation = "EvictBeforePackPublish"
    /\ hot' = hot \ {object}
    /\ unsafeEvict' = (unsafeEvict \/ ~HotEvictionSafe(object))
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           snapshotRoot, snapshotUsed, retiredSnapshots, publishedRoots,
           rootParent, rootImage, builtPacks,
           packMembers, cosPacks, verifiedPacks, location, unsafePublish,
           unsafeDelete, unsafeRewrite, unsafeRepackGap
       >>

PackReferenced(pack) ==
    \E object \in issued : location[object] = pack

DeletePack(pack) ==
    /\ pack \in cosPacks
    /\ \/ ~PackReferenced(pack)
       \/ Mutation = "DeleteReferencedPack"
    /\ cosPacks' = cosPacks \ {pack}
    /\ verifiedPacks' = verifiedPacks \ {pack}
    /\ unsafeDelete' = (unsafeDelete \/ PackReferenced(pack))
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           snapshotRoot, snapshotUsed, retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot,
           builtPacks, packMembers, location, unsafePublish, unsafeEvict,
           unsafeRewrite, unsafeRepackGap
       >>

RewritePack(pack, members) ==
    /\ Mutation = "RewriteImmutablePack"
    /\ pack \in builtPacks
    /\ members \in SUBSET issued
    /\ members # {}
    /\ members # packMembers[pack]
    /\ packMembers' = [packMembers EXCEPT ![pack] = members]
    /\ unsafeRewrite' = TRUE
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           snapshotRoot, snapshotUsed, retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot,
           builtPacks, cosPacks, verifiedPacks, location, unsafePublish,
           unsafeDelete, unsafeEvict, unsafeRepackGap
       >>

BreakRepack(object) ==
    /\ Mutation = "RepackGap"
    /\ object \in GcLiveObjects
    /\ object \notin hot
    /\ ColdStored(object)
    /\ location' = [location EXCEPT ![object] = NoPack]
    /\ unsafeRepackGap' = TRUE
    /\ UNCHANGED <<
           nextVersion, issued, activeLayers, retiredLayers, layerRoot,
           snapshotRoot, snapshotUsed, retiredSnapshots, publishedRoots,
           rootParent, rootImage, hot,
           builtPacks, packMembers, cosPacks, verifiedPacks, unsafePublish,
           unsafeDelete, unsafeEvict, unsafeRewrite
       >>

Next ==
    \/ \E layer \in Layers, root \in Roots,
          block \in Blocks, value \in Values :
           WriteAndPublishRoot(layer, root, block, value)
    \/ \E layer \in Layers, snapshot \in Snapshots :
           CreateSnapshot(layer, snapshot)
    \/ \E snapshot \in Snapshots : DeleteSnapshot(snapshot)
    \/ \E source \in Layers, child \in Layers : ForkLayer(source, child)
    \/ \E layer \in Layers : DeleteLayer(layer)
    \/ \E source \in Layers, child \in Layers :
          ReuseDeletedLayer(source, child)
    \/ \E layer \in Layers, snapshot \in Snapshots :
          ReuseDeletedSnapshot(layer, snapshot)
    \/ \E pack \in Packs, members \in SUBSET issued : BuildPack(pack, members)
    \/ \E pack \in Packs : PutPack(pack)
    \/ \E pack \in Packs : VerifyPack(pack)
    \/ \E pack \in Packs, object \in issued : PublishMember(pack, object)
    \/ \E object \in issued : DropDeadLocation(object)
    \/ \E object \in hot : DropHot(object)
    \/ \E pack \in Packs : DeletePack(pack)
    \/ \E pack \in Packs, members \in SUBSET issued : RewritePack(pack, members)
    \/ \E object \in issued : BreakRepack(object)

Spec == Init /\ [][Next]_vars

=============================================================================
