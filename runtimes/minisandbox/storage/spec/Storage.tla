----------------------------- MODULE Storage -----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Blocks, Values, Writers, MaxVersion, MaxEpoch, MaxCommits, Mutation

ASSUME /\ Blocks # {}
       /\ Values # {}
       /\ Writers # {}
       /\ MaxVersion \in Nat \ {0}
       /\ MaxEpoch \in Nat \ {0}
       /\ MaxCommits \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "AckBeforeSync",
            "CommitBeforeObjects",
            "ReclaimBeforeManifest",
            "AcceptStaleWrite",
            "AcceptStaleCommit"
          }

NoObj == [block |-> "NoBlock", version |-> 0, value |-> "NoValue"]
Obj(block, version, value) ==
    [block |-> block, version |-> version, value |-> value]

ObjectUniverse ==
    {NoObj} \cup
    {Obj(block, version, value) :
        block \in Blocks, version \in 1..MaxVersion, value \in Values}

EmptyImage == [block \in Blocks |-> NoObj]
Images == [Blocks -> ObjectUniverse]

LatestImage(left, right) ==
    [block \in Blocks |->
        IF right[block].version >= left[block].version
        THEN right[block]
        ELSE left[block]]

ObjectsIn(image) == {image[block] : block \in Blocks} \ {NoObj}

ImageTypeOK(image) ==
    /\ image \in Images
    /\ \A block \in Blocks :
           \/ image[block] = NoObj
           \/ image[block].block = block

InitialWriter == CHOOSE writer \in Writers : TRUE

VARIABLES
    running,
    epoch,
    heldEpoch,
    nextVersion,
    volatile,
    issued,
    cbsData,
    cbsHead,
    flushPhase,
    flushImage,
    acked,
    s3Objects,
    verified,
    putOps,
    headOps,
    commitOps,
    manifestGen,
    manifest,
    manifestHighWater,
    successfulCas,
    staleRejected,
    staleMutation,
    duplicateCasSuccess

vars == <<
    running,
    epoch,
    heldEpoch,
    nextVersion,
    volatile,
    issued,
    cbsData,
    cbsHead,
    flushPhase,
    flushImage,
    acked,
    s3Objects,
    verified,
    putOps,
    headOps,
    commitOps,
    manifestGen,
    manifest,
    manifestHighWater,
    successfulCas,
    staleRejected,
    staleMutation,
    duplicateCasSuccess
>>

Current(writer) ==
    /\ running
    /\ heldEpoch[writer] = epoch

CurrentImage ==
    [block \in Blocks |->
        IF volatile[block] # NoObj
        THEN volatile[block]
        ELSE IF cbsHead[block] # NoObj
             THEN cbsHead[block]
             ELSE manifest[block]]

CandidateImage ==
    [block \in Blocks |->
        IF cbsHead[block] # NoObj
        THEN cbsHead[block]
        ELSE manifest[block]]

PutOp(writer, object) ==
    [writer |-> writer, epoch |-> epoch, object |-> object]

HeadOp(writer, object) ==
    [writer |-> writer, epoch |-> epoch, object |-> object]

CommitOp(writer) ==
    [writer |-> writer,
     epoch |-> epoch,
     expected |-> manifestGen,
     image |-> CandidateImage]

OpIsCurrent(op) ==
    /\ running
    /\ op.epoch = epoch
    /\ heldEpoch[op.writer] = epoch

Init ==
    /\ running = TRUE
    /\ epoch = 1
    /\ heldEpoch =
           [writer \in Writers |-> IF writer = InitialWriter THEN 1 ELSE 0]
    /\ nextVersion = 1
    /\ volatile = EmptyImage
    /\ issued = {}
    /\ cbsData = {}
    /\ cbsHead = EmptyImage
    /\ flushPhase = "Idle"
    /\ flushImage = EmptyImage
    /\ acked = EmptyImage
    /\ s3Objects = {}
    /\ verified = {}
    /\ putOps = {}
    /\ headOps = {}
    /\ commitOps = {}
    /\ manifestGen = 0
    /\ manifest = EmptyImage
    /\ manifestHighWater = [block \in Blocks |-> 0]
    /\ successfulCas = {}
    /\ staleRejected = FALSE
    /\ staleMutation = FALSE
    /\ duplicateCasSuccess = FALSE

Write(writer, block, value) ==
    LET object == Obj(block, nextVersion, value) IN
    /\ Current(writer)
    /\ flushPhase = "Idle"
    /\ nextVersion <= MaxVersion
    /\ volatile' = [volatile EXCEPT ![block] = object]
    /\ issued' = issued \cup {object}
    /\ nextVersion' = nextVersion + 1
    /\ UNCHANGED <<
           running, epoch, heldEpoch, cbsData, cbsHead,
           flushPhase, flushImage, acked, s3Objects, verified,
           putOps, headOps, commitOps, manifestGen, manifest,
           manifestHighWater, successfulCas, staleRejected, staleMutation,
           duplicateCasSuccess
       >>

BeginFlush(writer) ==
    /\ Current(writer)
    /\ flushPhase = "Idle"
    /\ \E block \in Blocks : volatile[block] # NoObj
    /\ flushPhase' = "Pending"
    /\ flushImage' = CurrentImage
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, acked, s3Objects, verified,
           putOps, headOps, commitOps, manifestGen, manifest,
           manifestHighWater, successfulCas, staleRejected, staleMutation,
           duplicateCasSuccess
       >>

CbsSync ==
    /\ running
    /\ flushPhase = "Pending"
    /\ cbsData' = cbsData \cup ObjectsIn(flushImage)
    /\ cbsHead' = flushImage
    /\ volatile' = EmptyImage
    /\ flushPhase' = "Synced"
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, issued, flushImage,
           acked, s3Objects, verified, putOps, headOps, commitOps,
           manifestGen, manifest, manifestHighWater, successfulCas,
           staleRejected, staleMutation, duplicateCasSuccess
       >>

AckFlush ==
    /\ running
    /\ \/ flushPhase = "Synced"
       \/ /\ Mutation = "AckBeforeSync"
          /\ flushPhase = "Pending"
    \* acked is an observer history, not algorithm state. Keeping the newest
    \* response prevents a later bug from erasing an earlier successful FLUSH
    \* from the safety oracle.
    /\ acked' = LatestImage(acked, flushImage)
    /\ flushPhase' = "Idle"
    /\ flushImage' = EmptyImage
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, s3Objects, verified, putOps, headOps,
           commitOps, manifestGen, manifest, manifestHighWater,
           successfulCas, staleRejected, staleMutation, duplicateCasSuccess
       >>

StartPut(writer, object) ==
    LET op == PutOp(writer, object) IN
    /\ Current(writer)
    /\ object \in cbsData
    /\ op \notin putOps
    /\ putOps' = putOps \cup {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked,
           s3Objects, verified, headOps, commitOps, manifestGen,
           manifest, manifestHighWater, successfulCas,
           staleRejected, staleMutation, duplicateCasSuccess
       >>

PutSuccess(op) ==
    /\ op \in putOps
    /\ putOps' = putOps \ {op}
    /\ s3Objects' = s3Objects \cup {op.object.value}
    /\ verified' =
           IF OpIsCurrent(op)
           THEN verified \cup {op.object}
           ELSE verified
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked, headOps,
           commitOps, manifestGen, manifest, manifestHighWater,
           successfulCas, staleRejected, staleMutation, duplicateCasSuccess
       >>

PutTimeoutAfterCommit(op) ==
    /\ op \in putOps
    /\ putOps' = putOps \ {op}
    /\ s3Objects' = s3Objects \cup {op.object.value}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked, verified,
           headOps, commitOps, manifestGen, manifest,
           manifestHighWater, successfulCas, staleRejected, staleMutation,
           duplicateCasSuccess
       >>

PutTimeoutBeforeCommit(op) ==
    /\ op \in putOps
    /\ putOps' = putOps \ {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked,
           s3Objects, verified, headOps, commitOps, manifestGen,
           manifest, manifestHighWater, successfulCas,
           staleRejected, staleMutation, duplicateCasSuccess
       >>

StartHead(writer, object) ==
    LET op == HeadOp(writer, object) IN
    /\ Current(writer)
    /\ object \in cbsData \cup ObjectsIn(manifest)
    /\ op \notin headOps
    /\ headOps' = headOps \cup {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked,
           s3Objects, verified, putOps, commitOps, manifestGen,
           manifest, manifestHighWater, successfulCas,
           staleRejected, staleMutation, duplicateCasSuccess
       >>

HeadPresent(op) ==
    /\ op \in headOps
    /\ op.object.value \in s3Objects
    /\ headOps' = headOps \ {op}
    /\ verified' =
           IF OpIsCurrent(op)
           THEN verified \cup {op.object}
           ELSE verified
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked,
           s3Objects, putOps, commitOps, manifestGen, manifest,
           manifestHighWater, successfulCas, staleRejected, staleMutation,
           duplicateCasSuccess
       >>

HeadAbsent(op) ==
    /\ op \in headOps
    /\ headOps' = headOps \ {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked,
           s3Objects, verified, putOps, commitOps, manifestGen,
           manifest, manifestHighWater, successfulCas,
           staleRejected, staleMutation, duplicateCasSuccess
       >>

HeadCorrupt(op) ==
    /\ op \in headOps
    /\ headOps' = headOps \ {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked,
           s3Objects, verified, putOps, commitOps, manifestGen,
           manifest, manifestHighWater, successfulCas,
           staleRejected, staleMutation, duplicateCasSuccess
       >>

StartCommit(writer) ==
    LET op == CommitOp(writer) IN
    /\ Current(writer)
    /\ flushPhase = "Idle"
    /\ manifestGen < MaxCommits
    /\ ObjectsIn(CandidateImage) # {}
    /\ \/ ObjectsIn(CandidateImage) \subseteq verified
       \/ Mutation = "CommitBeforeObjects"
    /\ op \notin commitOps
    /\ commitOps' = commitOps \cup {op}
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked,
           s3Objects, verified, putOps, headOps, manifestGen,
           manifest, manifestHighWater, successfulCas,
           staleRejected, staleMutation, duplicateCasSuccess
       >>

MaxNat(left, right) == IF left >= right THEN left ELSE right

CommitResult(op) ==
    LET normalSuccess ==
            /\ OpIsCurrent(op)
            /\ op.expected = manifestGen
            /\ manifestGen < MaxCommits
        applied ==
            normalSuccess \/
            /\ Mutation = "AcceptStaleCommit"
            /\ ~OpIsCurrent(op)
    IN
    /\ op \in commitOps
    /\ commitOps' = commitOps \ {op}
    /\ IF applied
       THEN /\ manifest' = op.image
            /\ manifestGen' = op.expected + 1
            /\ manifestHighWater' =
                   [block \in Blocks |->
                       MaxNat(manifestHighWater[block],
                              op.image[block].version)]
            /\ successfulCas' = successfulCas \cup {op.expected}
            /\ duplicateCasSuccess' =
                   IF op.expected \in successfulCas
                   THEN TRUE
                   ELSE duplicateCasSuccess
       ELSE /\ UNCHANGED manifest
            /\ UNCHANGED manifestGen
            /\ UNCHANGED manifestHighWater
            /\ UNCHANGED successfulCas
            /\ UNCHANGED duplicateCasSuccess
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           cbsData, cbsHead, flushPhase, flushImage, acked,
           s3Objects, verified, putOps, headOps,
           staleRejected, staleMutation
       >>

SafeToReclaim(object) ==
    \/ cbsHead[object.block] # object
    \/ /\ manifest[object.block] = object
       /\ object.value \in s3Objects

Reclaim(writer, object) ==
    /\ Current(writer)
    /\ flushPhase = "Idle"
    /\ object \in cbsData
    /\ \/ SafeToReclaim(object)
       \/ Mutation = "ReclaimBeforeManifest"
    /\ cbsData' = cbsData \ {object}
    /\ cbsHead' =
           IF cbsHead[object.block] = object
           THEN [cbsHead EXCEPT ![object.block] = NoObj]
           ELSE cbsHead
    /\ UNCHANGED <<
           running, epoch, heldEpoch, nextVersion, volatile, issued,
           flushPhase, flushImage, acked, s3Objects, verified,
           putOps, headOps, commitOps, manifestGen, manifest,
           manifestHighWater, successfulCas, staleRejected, staleMutation,
           duplicateCasSuccess
       >>

Crash ==
    /\ running
    /\ running' = FALSE
    /\ volatile' = EmptyImage
    /\ flushPhase' = "Idle"
    /\ flushImage' = EmptyImage
    /\ verified' = {}
    /\ UNCHANGED <<
           epoch, heldEpoch, nextVersion, issued, cbsData, cbsHead,
           acked, s3Objects, putOps, headOps, commitOps, manifestGen,
           manifest, manifestHighWater, successfulCas,
           staleRejected, staleMutation, duplicateCasSuccess
       >>

Recover(writer) ==
    /\ ~running
    /\ epoch < MaxEpoch
    /\ running' = TRUE
    /\ epoch' = epoch + 1
    /\ heldEpoch' = [heldEpoch EXCEPT ![writer] = epoch + 1]
    /\ UNCHANGED <<
           nextVersion, volatile, issued, cbsData, cbsHead,
           flushPhase, flushImage, acked, s3Objects, verified,
           putOps, headOps, commitOps, manifestGen, manifest,
           manifestHighWater, successfulCas, staleRejected, staleMutation,
           duplicateCasSuccess
       >>

StaleWrite(writer, block, value) ==
    LET object == Obj(block, nextVersion, value) IN
    /\ running
    /\ heldEpoch[writer] > 0
    /\ heldEpoch[writer] # epoch
    /\ ~staleRejected
    /\ ~staleMutation
    /\ nextVersion <= MaxVersion
    /\ IF Mutation = "AcceptStaleWrite"
       THEN /\ volatile' = [volatile EXCEPT ![block] = object]
            /\ issued' = issued \cup {object}
            /\ nextVersion' = nextVersion + 1
            /\ staleMutation' = TRUE
            /\ UNCHANGED staleRejected
       ELSE /\ staleRejected' = TRUE
            /\ UNCHANGED volatile
            /\ UNCHANGED issued
            /\ UNCHANGED nextVersion
            /\ UNCHANGED staleMutation
    /\ UNCHANGED <<
           running, epoch, heldEpoch, cbsData, cbsHead,
           flushPhase, flushImage, acked, s3Objects, verified,
           putOps, headOps, commitOps, manifestGen, manifest,
           manifestHighWater, successfulCas, duplicateCasSuccess
       >>

Next ==
    \/ \E writer \in Writers, block \in Blocks, value \in Values :
           Write(writer, block, value)
    \/ \E writer \in Writers : BeginFlush(writer)
    \/ CbsSync
    \/ AckFlush
    \/ \E writer \in Writers, object \in cbsData : StartPut(writer, object)
    \/ \E op \in putOps : PutSuccess(op)
    \/ \E op \in putOps : PutTimeoutAfterCommit(op)
    \/ \E op \in putOps : PutTimeoutBeforeCommit(op)
    \/ \E writer \in Writers,
          object \in cbsData \cup ObjectsIn(manifest) :
           StartHead(writer, object)
    \/ \E op \in headOps : HeadPresent(op)
    \/ \E op \in headOps : HeadAbsent(op)
    \/ \E op \in headOps : HeadCorrupt(op)
    \/ \E writer \in Writers : StartCommit(writer)
    \/ \E op \in commitOps : CommitResult(op)
    \/ \E writer \in Writers, object \in cbsData : Reclaim(writer, object)
    \/ Crash
    \/ \E writer \in Writers : Recover(writer)
    \/ \E writer \in Writers, block \in Blocks, value \in Values :
           StaleWrite(writer, block, value)

Spec == Init /\ [][Next]_vars

=============================================================================
