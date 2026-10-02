-------------------- MODULE SettlementRoundLifecycle --------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Blocks, Values, MaxVersion, MaxGeneration, Mutation

NoObj == [block |-> "NoBlock", version |-> 0, value |-> "NoValue"]

ASSUME /\ Blocks # {}
       /\ Values # {}
       /\ MaxVersion \in Nat \ {0}
       /\ MaxGeneration \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "AdvanceCutoffAfterCrash",
            "AdmitPostCutoff",
            "EvictBeforePublish",
            "CompleteRoundEarly"
          }

Obj(block, version, value) ==
    [block |-> block, version |-> version, value |-> value]

Objects ==
    {Obj(block, version, value) :
        block \in Blocks, version \in 1..MaxVersion, value \in Values}

ObjectUniverse == Objects \cup {NoObj}
RoundStates == {"Idle", "Active"}
IntentStates == {"Missing", "Prepared", "Verified", "Published"}

FunctionRange(function) == {function[key] : key \in DOMAIN function}

VARIABLES
    running,
    generation,
    nextVersion,
    issued,
    head,
    pinned,
    hot,
    cold,
    roundState,
    roundCutoff,
    roundBudget,
    roundProcessed,
    intentState,
    intentMembers,
    intentGeneration,
    cosStored,
    unsafeCutoffChange,
    unsafePostCutoff,
    unsafeEvict,
    unsafeComplete

vars == <<
    running,
    generation,
    nextVersion,
    issued,
    head,
    pinned,
    hot,
    cold,
    roundState,
    roundCutoff,
    roundBudget,
    roundProcessed,
    intentState,
    intentMembers,
    intentGeneration,
    cosStored,
    unsafeCutoffChange,
    unsafePostCutoff,
    unsafeEvict,
    unsafeComplete
>>

LiveObjects == (FunctionRange(head) \ {NoObj}) \cup pinned

Recoverable(object) == object \in hot \/ object \in cold

EligibleAt(cutoff) ==
    {object \in hot \cap LiveObjects : object.version <= cutoff}

RemainingRoundHot ==
    {object \in hot : object.version <= roundCutoff}

Init ==
    /\ running = TRUE
    /\ generation = 1
    /\ nextVersion = 1
    /\ issued = {}
    /\ head = [block \in Blocks |-> NoObj]
    /\ pinned = {}
    /\ hot = {}
    /\ cold = {}
    /\ roundState = "Idle"
    /\ roundCutoff = 0
    /\ roundBudget = 0
    /\ roundProcessed = 0
    /\ intentState = "Missing"
    /\ intentMembers = {}
    /\ intentGeneration = 0
    /\ cosStored = FALSE
    /\ unsafeCutoffChange = FALSE
    /\ unsafePostCutoff = FALSE
    /\ unsafeEvict = FALSE
    /\ unsafeComplete = FALSE

Write(block, value) ==
    LET object == Obj(block, nextVersion, value) IN
    /\ running
    /\ nextVersion <= MaxVersion
    /\ object \notin issued
    /\ nextVersion' = nextVersion + 1
    /\ issued' = issued \cup {object}
    /\ head' = [head EXCEPT ![block] = object]
    /\ hot' = hot \cup {object}
    /\ UNCHANGED <<
           running, generation, pinned, cold, roundState, roundCutoff,
           roundBudget, roundProcessed, intentState, intentMembers,
           intentGeneration, cosStored, unsafeCutoffChange,
           unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

PinHead(block) ==
    /\ running
    /\ head[block] # NoObj
    /\ pinned' = pinned \cup {head[block]}
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, hot, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           intentState, intentMembers, intentGeneration, cosStored,
           unsafeCutoffChange, unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

Unpin(object) ==
    /\ running
    /\ object \in pinned
    /\ pinned' = pinned \ {object}
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, hot, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           intentState, intentMembers, intentGeneration, cosStored,
           unsafeCutoffChange, unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

CaptureRound(budget) ==
    LET cutoff == nextVersion - 1
        eligible == EligibleAt(cutoff)
    IN
    /\ running
    /\ roundState = "Idle"
    /\ intentState = "Missing"
    /\ eligible # {}
    /\ budget \in 1..Cardinality(eligible)
    /\ roundState' = "Active"
    /\ roundCutoff' = cutoff
    /\ roundBudget' = budget
    /\ roundProcessed' = 0
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot, cold,
           intentState, intentMembers, intentGeneration, cosStored,
           unsafeCutoffChange, unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

PrepareIntent(members) ==
    /\ running
    /\ roundState = "Active"
    /\ intentState = "Missing"
    /\ members \in SUBSET RemainingRoundHot
    /\ members # {}
    /\ Cardinality(members) <= roundBudget - roundProcessed
    /\ intentState' = "Prepared"
    /\ intentMembers' = members
    /\ intentGeneration' = generation
    /\ cosStored' = FALSE
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           unsafeCutoffChange, unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

DropDeadOldVersion(object) ==
    /\ running
    /\ roundState = "Active"
    /\ intentState = "Missing"
    /\ object \in RemainingRoundHot
    /\ object \notin LiveObjects
    /\ hot' = hot \ {object}
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           intentState, intentMembers, intentGeneration, cosStored,
           unsafeCutoffChange, unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

PutIntent ==
    /\ running
    /\ intentState = "Prepared"
    /\ intentGeneration = generation
    /\ cosStored' = TRUE
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           intentState, intentMembers, intentGeneration, unsafeCutoffChange,
           unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

VerifyIntent ==
    /\ running
    /\ intentState = "Prepared"
    /\ intentGeneration = generation
    /\ cosStored
    /\ intentState' = "Verified"
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           intentMembers, intentGeneration, cosStored, unsafeCutoffChange,
           unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

PublishIntent ==
    /\ running
    /\ intentState = "Verified"
    /\ intentGeneration = generation
    /\ cosStored
    /\ cold' = cold \cup intentMembers
    /\ intentState' = "Published"
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot,
           roundState, roundCutoff, roundBudget, roundProcessed,
           intentMembers, intentGeneration, cosStored, unsafeCutoffChange,
           unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

EvictIntentMember(object) ==
    /\ running
    /\ object \in intentMembers \cap hot
    /\ \/ intentState = "Published"
       \/ Mutation = "EvictBeforePublish"
    /\ hot' = hot \ {object}
    /\ unsafeEvict' =
           (unsafeEvict \/ (object \in LiveObjects /\ object \notin cold))
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           intentState, intentMembers, intentGeneration, cosStored,
           unsafeCutoffChange, unsafePostCutoff, unsafeComplete
       >>

CompleteIntent ==
    /\ running
    /\ intentState = "Published"
    /\ intentMembers \cap hot = {}
    /\ roundProcessed' = roundProcessed + Cardinality(intentMembers)
    /\ intentState' = "Missing"
    /\ intentMembers' = {}
    /\ intentGeneration' = 0
    /\ cosStored' = FALSE
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot, cold,
           roundState, roundCutoff, roundBudget, unsafeCutoffChange,
           unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

FinishRound ==
    /\ running
    /\ roundState = "Active"
    /\ intentState = "Missing"
    /\ \/ roundProcessed = roundBudget
       \/ RemainingRoundHot = {}
       \/ Mutation = "CompleteRoundEarly"
    /\ roundState' = "Idle"
    /\ roundCutoff' = 0
    /\ roundBudget' = 0
    /\ roundProcessed' = 0
    /\ unsafeComplete' =
           (unsafeComplete \/
            ~(roundProcessed = roundBudget \/ RemainingRoundHot = {}))
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot, cold,
           intentState, intentMembers, intentGeneration, cosStored,
           unsafeCutoffChange, unsafePostCutoff, unsafeEvict
       >>

Crash ==
    /\ running
    /\ running' = FALSE
    /\ UNCHANGED <<
           generation, nextVersion, issued, head, pinned, hot, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           intentState, intentMembers, intentGeneration, cosStored,
           unsafeCutoffChange, unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

Recover ==
    /\ ~running
    /\ generation < MaxGeneration
    /\ running' = TRUE
    /\ generation' = generation + 1
    /\ UNCHANGED <<
           nextVersion, issued, head, pinned, hot, cold, roundState,
           roundCutoff, roundBudget, roundProcessed, intentState,
           intentMembers, intentGeneration, cosStored, unsafeCutoffChange,
           unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

ClaimIntent ==
    /\ running
    /\ intentState # "Missing"
    /\ intentGeneration < generation
    /\ intentGeneration' = generation
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           intentState, intentMembers, cosStored, unsafeCutoffChange,
           unsafePostCutoff, unsafeEvict, unsafeComplete
       >>

AdvanceCutoffAfterCrash ==
    /\ Mutation = "AdvanceCutoffAfterCrash"
    /\ running
    /\ roundState = "Active"
    /\ generation > 1
    /\ intentState = "Missing"
    /\ nextVersion - 1 > roundCutoff
    /\ roundCutoff' = nextVersion - 1
    /\ unsafeCutoffChange' = TRUE
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot, cold,
           roundState, roundBudget, roundProcessed, intentState,
           intentMembers, intentGeneration, cosStored, unsafePostCutoff,
           unsafeEvict, unsafeComplete
       >>

AdmitPostCutoff(object) ==
    /\ Mutation = "AdmitPostCutoff"
    /\ running
    /\ roundState = "Active"
    /\ intentState = "Missing"
    /\ roundProcessed < roundBudget
    /\ object \in hot
    /\ object.version > roundCutoff
    /\ intentState' = "Prepared"
    /\ intentMembers' = {object}
    /\ intentGeneration' = generation
    /\ cosStored' = FALSE
    /\ unsafePostCutoff' = TRUE
    /\ UNCHANGED <<
           running, generation, nextVersion, issued, head, pinned, hot, cold,
           roundState, roundCutoff, roundBudget, roundProcessed,
           unsafeCutoffChange, unsafeEvict, unsafeComplete
       >>

Next ==
    \/ \E block \in Blocks, value \in Values : Write(block, value)
    \/ \E block \in Blocks : PinHead(block)
    \/ \E object \in Objects : Unpin(object)
    \/ \E budget \in 1..MaxVersion : CaptureRound(budget)
    \/ \E members \in SUBSET Objects : PrepareIntent(members)
    \/ \E object \in Objects : DropDeadOldVersion(object)
    \/ PutIntent
    \/ VerifyIntent
    \/ PublishIntent
    \/ \E object \in Objects : EvictIntentMember(object)
    \/ CompleteIntent
    \/ FinishRound
    \/ Crash
    \/ Recover
    \/ ClaimIntent
    \/ AdvanceCutoffAfterCrash
    \/ \E object \in Objects : AdmitPostCutoff(object)

Spec == Init /\ [][Next]_vars

=============================================================================
