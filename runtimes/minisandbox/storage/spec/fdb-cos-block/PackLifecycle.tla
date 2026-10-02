------------------------- MODULE PackLifecycle -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Blocks, Values, Packs, MaxVersion, Mutation

ASSUME /\ Blocks # {}
       /\ Values # {}
       /\ Packs # {}
       /\ MaxVersion \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "PublishUnverifiedPack",
            "DeleteReferencedPack",
            "EvictBeforePackPublish",
            "RewriteImmutablePack",
            "RepackGap"
          }

NoObj == [block |-> "NoBlock", version |-> 0, value |-> "NoValue"]
NoPack == "NoPack"

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

VARIABLES
    nextVersion,
    issued,
    head,
    snapshotImage,
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
    head,
    snapshotImage,
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

ColdDurable(object) ==
    LET pack == location[object] IN
    /\ pack # NoPack
    /\ pack \in cosPacks
    /\ pack \in verifiedPacks
    /\ object \in packMembers[pack]

Durable(object) == object \in hot \/ ColdDurable(object)

LiveObjects == ObjectsIn(head) \cup ObjectsIn(snapshotImage)

Init ==
    /\ nextVersion = 1
    /\ issued = {}
    /\ head = EmptyImage
    /\ snapshotImage = EmptyImage
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

Write(block, value) ==
    LET object == Obj(block, nextVersion, value) IN
    /\ nextVersion <= MaxVersion
    /\ issued' = issued \cup {object}
    /\ hot' = hot \cup {object}
    /\ head' = [head EXCEPT ![block] = object]
    /\ nextVersion' = nextVersion + 1
    /\ UNCHANGED <<
           snapshotImage, builtPacks, packMembers, cosPacks,
           verifiedPacks, location, unsafePublish, unsafeDelete,
           unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

PinSnapshot ==
    /\ snapshotImage = EmptyImage
    /\ ObjectsIn(head) # {}
    /\ \A object \in ObjectsIn(head) : Durable(object)
    /\ snapshotImage' = head
    /\ UNCHANGED <<
           nextVersion, issued, head, hot, builtPacks, packMembers,
           cosPacks, verifiedPacks, location, unsafePublish, unsafeDelete,
           unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

BuildPack(pack, members) ==
    /\ pack \notin builtPacks
    /\ members \in SUBSET issued
    /\ members # {}
    /\ \A object \in members : Durable(object)
    /\ builtPacks' = builtPacks \cup {pack}
    /\ packMembers' = [packMembers EXCEPT ![pack] = members]
    /\ UNCHANGED <<
           nextVersion, issued, head, snapshotImage, hot, cosPacks,
           verifiedPacks, location, unsafePublish, unsafeDelete,
           unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

PutPackApplied(pack) ==
    /\ pack \in builtPacks
    /\ pack \notin cosPacks
    /\ cosPacks' = cosPacks \cup {pack}
    /\ UNCHANGED <<
           nextVersion, issued, head, snapshotImage, hot, builtPacks,
           packMembers, verifiedPacks, location, unsafePublish,
           unsafeDelete, unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

VerifyPack(pack) ==
    /\ pack \in cosPacks
    /\ pack \notin verifiedPacks
    /\ verifiedPacks' = verifiedPacks \cup {pack}
    /\ UNCHANGED <<
           nextVersion, issued, head, snapshotImage, hot, builtPacks,
           packMembers, cosPacks, location, unsafePublish, unsafeDelete,
           unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

PublishMember(pack, object) ==
    /\ pack \in builtPacks
    /\ object \in packMembers[pack]
    /\ object \in LiveObjects
    /\ location[object] # pack
    /\ \/ /\ pack \in cosPacks
           /\ pack \in verifiedPacks
       \/ Mutation = "PublishUnverifiedPack"
    /\ location' = [location EXCEPT ![object] = pack]
    /\ unsafePublish' =
           (unsafePublish \/
            ~(pack \in cosPacks /\ pack \in verifiedPacks))
    /\ UNCHANGED <<
           nextVersion, issued, head, snapshotImage, hot, builtPacks,
           packMembers, cosPacks, verifiedPacks, unsafeDelete,
           unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

DropDeadLocation(object) ==
    /\ object \in issued
    /\ object \notin LiveObjects
    /\ location[object] # NoPack
    /\ location' = [location EXCEPT ![object] = NoPack]
    /\ UNCHANGED <<
           nextVersion, issued, head, snapshotImage, hot, builtPacks,
           packMembers, cosPacks, verifiedPacks, unsafePublish,
           unsafeDelete, unsafeEvict, unsafeRewrite, unsafeRepackGap
       >>

HotEvictionSafe(object) ==
    \/ object \notin LiveObjects
    \/ ColdDurable(object)

DropHot(object) ==
    /\ object \in hot
    /\ \/ HotEvictionSafe(object)
       \/ Mutation = "EvictBeforePackPublish"
    /\ hot' = hot \ {object}
    /\ unsafeEvict' = (unsafeEvict \/ ~HotEvictionSafe(object))
    /\ UNCHANGED <<
           nextVersion, issued, head, snapshotImage, builtPacks,
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
           nextVersion, issued, head, snapshotImage, hot, builtPacks,
           packMembers, location, unsafePublish, unsafeEvict,
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
           nextVersion, issued, head, snapshotImage, hot, builtPacks,
           cosPacks, verifiedPacks, location, unsafePublish, unsafeDelete,
           unsafeEvict, unsafeRepackGap
       >>

BreakRepack(object) ==
    /\ Mutation = "RepackGap"
    /\ object \in LiveObjects
    /\ object \notin hot
    /\ ColdDurable(object)
    /\ location' = [location EXCEPT ![object] = NoPack]
    /\ unsafeRepackGap' = TRUE
    /\ UNCHANGED <<
           nextVersion, issued, head, snapshotImage, hot, builtPacks,
           packMembers, cosPacks, verifiedPacks, unsafePublish,
           unsafeDelete, unsafeEvict, unsafeRewrite
       >>

Next ==
    \/ \E block \in Blocks, value \in Values : Write(block, value)
    \/ PinSnapshot
    \/ \E pack \in Packs, members \in SUBSET issued :
           BuildPack(pack, members)
    \/ \E pack \in Packs : PutPackApplied(pack)
    \/ \E pack \in Packs : VerifyPack(pack)
    \/ \E pack \in Packs, object \in issued : PublishMember(pack, object)
    \/ \E object \in issued : DropDeadLocation(object)
    \/ \E object \in hot : DropHot(object)
    \/ \E pack \in Packs : DeletePack(pack)
    \/ \E pack \in Packs, members \in SUBSET issued :
           RewritePack(pack, members)
    \/ \E object \in issued : BreakRepack(object)

Spec == Init /\ [][Next]_vars

=============================================================================
