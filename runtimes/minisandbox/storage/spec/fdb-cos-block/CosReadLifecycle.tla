------------------------ MODULE CosReadLifecycle ------------------------
EXTENDS FiniteSets

CONSTANTS Objects, Packs, Readers, Mutation

NoObject == "NoObject"
NoPack == "NoPack"

ASSUME /\ Objects # {}
       /\ Packs # {}
       /\ Readers # {}
       /\ NoObject \notin Objects
       /\ NoPack \notin Packs
       /\ Mutation \in {
            "None",
            "ReturnCorruptBytes",
            "ReturnMissingAsZero"
          }

ReadPhases == {
    "Idle", "NeedResolve", "Resolved", "Missing", "FetchedGood",
    "FetchedBad", "Done", "Failed"
}

VARIABLES
    hot,
    builtPacks,
    packMembers,
    cosStored,
    verifiedPacks,
    location,
    readPhase,
    readObject,
    resolvedPack,
    readResult,
    wrongRead

vars == <<
    hot,
    builtPacks,
    packMembers,
    cosStored,
    verifiedPacks,
    location,
    readPhase,
    readObject,
    resolvedPack,
    readResult,
    wrongRead
>>

ColdStored(object) ==
    LET pack == location[object] IN
    /\ pack # NoPack
    /\ pack \in cosStored
    /\ pack \in verifiedPacks
    /\ object \in packMembers[pack]

DurableCopyExists(object) == object \in hot \/ ColdStored(object)

PackPublished(pack) ==
    \E object \in Objects : location[object] = pack

Init ==
    /\ hot = Objects
    /\ builtPacks = {}
    /\ packMembers = [pack \in Packs |-> {}]
    /\ cosStored = {}
    /\ verifiedPacks = {}
    /\ location = [object \in Objects |-> NoPack]
    /\ readPhase = [reader \in Readers |-> "Idle"]
    /\ readObject = [reader \in Readers |-> NoObject]
    /\ resolvedPack = [reader \in Readers |-> NoPack]
    /\ readResult = [reader \in Readers |-> NoObject]
    /\ wrongRead = FALSE

BuildPack(pack, members) ==
    /\ pack \notin builtPacks
    /\ members \in SUBSET Objects
    /\ members # {}
    /\ \A object \in members : DurableCopyExists(object)
    /\ builtPacks' = builtPacks \cup {pack}
    /\ packMembers' = [packMembers EXCEPT ![pack] = members]
    /\ UNCHANGED <<
           hot, cosStored, verifiedPacks, location, readPhase, readObject,
           resolvedPack, readResult, wrongRead
       >>

PutPack(pack) ==
    /\ pack \in builtPacks
    /\ pack \notin cosStored
    /\ cosStored' = cosStored \cup {pack}
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, verifiedPacks, location,
           readPhase, readObject, resolvedPack, readResult,
           wrongRead
       >>

VerifyPack(pack) ==
    /\ pack \in cosStored
    /\ pack \notin verifiedPacks
    /\ verifiedPacks' = verifiedPacks \cup {pack}
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, location,
           readPhase, readObject, resolvedPack, readResult,
           wrongRead
       >>

PublishLocation(pack, object) ==
    /\ pack \in verifiedPacks
    /\ object \in packMembers[pack]
    /\ location[object] # pack
    /\ location' = [location EXCEPT ![object] = pack]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks,
           readPhase, readObject, resolvedPack, readResult,
           wrongRead
       >>

DropHot(object) ==
    /\ object \in hot
    /\ ColdStored(object)
    /\ hot' = hot \ {object}
    /\ UNCHANGED <<
           builtPacks, packMembers, cosStored, verifiedPacks, location,
           readPhase, readObject, resolvedPack, readResult,
           wrongRead
       >>

DeleteUnpublishedPack(pack) ==
    /\ pack \in cosStored
    /\ ~PackPublished(pack)
    \* A reader may already have resolved this old pack. The object store GET
    \* can then return NotFound; correctness depends on re-resolving location.
    /\ cosStored' = cosStored \ {pack}
    /\ verifiedPacks' = verifiedPacks \ {pack}
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, location, readPhase, readObject,
           resolvedPack, readResult, wrongRead
       >>

StartRead(reader, object) ==
    /\ readPhase[reader] = "Idle"
    /\ object \notin hot
    /\ location[object] # NoPack
    /\ readPhase' = [readPhase EXCEPT ![reader] = "NeedResolve"]
    /\ readObject' = [readObject EXCEPT ![reader] = object]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           resolvedPack, readResult, wrongRead
       >>

ResolveRead(reader) ==
    LET object == readObject[reader] IN
    /\ readPhase[reader] = "NeedResolve"
    /\ object \in Objects
    /\ location[object] # NoPack
    /\ readPhase' = [readPhase EXCEPT ![reader] = "Resolved"]
    /\ resolvedPack' = [resolvedPack EXCEPT ![reader] = location[object]]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, readResult, wrongRead
       >>

FetchCorrect(reader) ==
    LET object == readObject[reader]
        pack == resolvedPack[reader]
    IN
    /\ readPhase[reader] = "Resolved"
    /\ pack \in cosStored
    /\ object \in packMembers[pack]
    /\ readPhase' = [readPhase EXCEPT ![reader] = "FetchedGood"]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, resolvedPack, readResult, wrongRead
       >>

FetchNotFound(reader) ==
    /\ readPhase[reader] = "Resolved"
    \* Tencent COS may transiently return NotFound even for a stored immutable
    \* key; the same outcome also represents a repack/delete race.
    /\ readPhase' = [readPhase EXCEPT ![reader] = "Missing"]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, resolvedPack, readResult, wrongRead
       >>

RetryMissing(reader) ==
    /\ readPhase[reader] = "Missing"
    /\ readPhase' = [readPhase EXCEPT ![reader] = "NeedResolve"]
    /\ resolvedPack' = [resolvedPack EXCEPT ![reader] = NoPack]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, readResult, wrongRead
       >>

FailMissing(reader) ==
    /\ readPhase[reader] = "Missing"
    /\ readPhase' = [readPhase EXCEPT ![reader] = "Failed"]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, resolvedPack, readResult, wrongRead
       >>

ReturnMissingAsZero(reader) ==
    /\ Mutation = "ReturnMissingAsZero"
    /\ readPhase[reader] = "Missing"
    /\ readPhase' = [readPhase EXCEPT ![reader] = "Done"]
    /\ readResult' = [readResult EXCEPT ![reader] = NoObject]
    /\ wrongRead' = TRUE
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, resolvedPack
       >>

FetchCorrupt(reader) ==
    /\ readPhase[reader] = "Resolved"
    /\ readPhase' = [readPhase EXCEPT ![reader] = "FetchedBad"]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, resolvedPack, readResult, wrongRead
       >>

RejectCorrupt(reader) ==
    /\ readPhase[reader] = "FetchedBad"
    /\ Mutation # "ReturnCorruptBytes"
    /\ readPhase' = [readPhase EXCEPT ![reader] = "NeedResolve"]
    /\ resolvedPack' = [resolvedPack EXCEPT ![reader] = NoPack]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, readResult, wrongRead
       >>

FailCorrupt(reader) ==
    /\ readPhase[reader] = "FetchedBad"
    /\ Mutation # "ReturnCorruptBytes"
    /\ readPhase' = [readPhase EXCEPT ![reader] = "Failed"]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, resolvedPack, readResult, wrongRead
       >>

ReturnCorrect(reader) ==
    /\ readPhase[reader] = "FetchedGood"
    /\ readPhase' = [readPhase EXCEPT ![reader] = "Done"]
    /\ readResult' = [readResult EXCEPT ![reader] = readObject[reader]]
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, resolvedPack, wrongRead
       >>

ReturnCorrupt(reader) ==
    /\ Mutation = "ReturnCorruptBytes"
    /\ readPhase[reader] = "FetchedBad"
    /\ readPhase' = [readPhase EXCEPT ![reader] = "Done"]
    /\ readResult' = [readResult EXCEPT ![reader] = NoObject]
    /\ wrongRead' = TRUE
    /\ UNCHANGED <<
           hot, builtPacks, packMembers, cosStored, verifiedPacks, location,
           readObject, resolvedPack
       >>

Next ==
    \/ \E pack \in Packs, members \in SUBSET Objects : BuildPack(pack, members)
    \/ \E pack \in Packs : PutPack(pack)
    \/ \E pack \in Packs : VerifyPack(pack)
    \/ \E pack \in Packs, object \in Objects : PublishLocation(pack, object)
    \/ \E object \in Objects : DropHot(object)
    \/ \E pack \in Packs : DeleteUnpublishedPack(pack)
    \/ \E reader \in Readers, object \in Objects : StartRead(reader, object)
    \/ \E reader \in Readers : ResolveRead(reader)
    \/ \E reader \in Readers : FetchCorrect(reader)
    \/ \E reader \in Readers : FetchNotFound(reader)
    \/ \E reader \in Readers : RetryMissing(reader)
    \/ \E reader \in Readers : FailMissing(reader)
    \/ \E reader \in Readers : ReturnMissingAsZero(reader)
    \/ \E reader \in Readers : FetchCorrupt(reader)
    \/ \E reader \in Readers : RejectCorrupt(reader)
    \/ \E reader \in Readers : FailCorrupt(reader)
    \/ \E reader \in Readers : ReturnCorrect(reader)
    \/ \E reader \in Readers : ReturnCorrupt(reader)

Spec == Init /\ [][Next]_vars

=============================================================================
