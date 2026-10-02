--------------------- MODULE CosReadLifecycleSafety ---------------------
EXTENDS CosReadLifecycle

TypeOK ==
    /\ hot \subseteq Objects
    /\ builtPacks \subseteq Packs
    /\ packMembers \in [Packs -> SUBSET Objects]
    /\ cosStored \subseteq builtPacks
    /\ verifiedPacks \subseteq cosStored
    /\ location \in [Objects -> Packs \cup {NoPack}]
    /\ readPhase \in [Readers -> ReadPhases]
    /\ readObject \in [Readers -> Objects \cup {NoObject}]
    /\ resolvedPack \in [Readers -> Packs \cup {NoPack}]
    /\ readResult \in [Readers -> Objects \cup {NoObject}]
    /\ wrongRead \in BOOLEAN

PublishedLocationsAuthentic ==
    \A object \in Objects :
        location[object] # NoPack
        => LET pack == location[object] IN
           /\ pack \in cosStored
           /\ pack \in verifiedPacks
           /\ object \in packMembers[pack]

EveryObjectHasDurableCopy ==
    \A object \in Objects :
        \/ object \in hot
        \/ LET pack == location[object] IN
           /\ pack # NoPack
           /\ pack \in cosStored
           /\ pack \in verifiedPacks
           /\ object \in packMembers[pack]

ReturnedBytesAuthentic ==
    /\ ~wrongRead
    /\ \A reader \in Readers :
           readPhase[reader] = "Done"
           => readResult[reader] = readObject[reader]

Safety ==
    /\ TypeOK
    /\ PublishedLocationsAuthentic
    /\ EveryObjectHasDurableCopy
    /\ ReturnedBytesAuthentic

=============================================================================
