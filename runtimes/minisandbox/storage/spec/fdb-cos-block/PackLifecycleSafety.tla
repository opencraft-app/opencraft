---------------------- MODULE PackLifecycleSafety ----------------------
EXTENDS PackLifecycle

OracleColdStored(object) ==
    LET pack == location[object] IN
    /\ pack # NoPack
    /\ pack \in cosPacks
    /\ pack \in verifiedPacks
    /\ object \in packMembers[pack]

OracleLiveObjects == ObjectsIn(head) \cup ObjectsIn(snapshotImage)

OracleDurableCopyExists(object) ==
    object \in hot \/ OracleColdStored(object)

TypeOK ==
    /\ nextVersion \in 1..(MaxVersion + 1)
    /\ issued \subseteq Objects
    /\ ImageTypeOK(head)
    /\ ImageTypeOK(snapshotImage)
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

PointersAuthentic ==
    /\ ObjectsIn(head) \subseteq issued
    /\ ObjectsIn(snapshotImage) \subseteq issued

LocationsAuthentic ==
    \A object \in issued :
        location[object] # NoPack
        => OracleColdStored(object)

LiveObjectsReadable ==
    \A object \in OracleLiveObjects : OracleDurableCopyExists(object)

NoUnverifiedPublication == ~unsafePublish

NoReferencedPackDeletion == ~unsafeDelete

NoUnsafeHotEviction == ~unsafeEvict

PackMembershipImmutable == ~unsafeRewrite

RepackIsGapFree == ~unsafeRepackGap

Safety ==
    /\ TypeOK
    /\ PointersAuthentic
    /\ LocationsAuthentic
    /\ LiveObjectsReadable
    /\ NoUnverifiedPublication
    /\ NoReferencedPackDeletion
    /\ NoUnsafeHotEviction
    /\ PackMembershipImmutable
    /\ RepackIsGapFree

=============================================================================
