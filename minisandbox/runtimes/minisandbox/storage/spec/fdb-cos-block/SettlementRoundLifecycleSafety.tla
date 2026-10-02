----------------- MODULE SettlementRoundLifecycleSafety -----------------
EXTENDS SettlementRoundLifecycle

TypeOK ==
    /\ running \in BOOLEAN
    /\ generation \in 1..MaxGeneration
    /\ nextVersion \in 1..(MaxVersion + 1)
    /\ issued \subseteq Objects
    /\ head \in [Blocks -> ObjectUniverse]
    /\ pinned \subseteq issued
    /\ hot \subseteq issued
    /\ cold \subseteq issued
    /\ roundState \in RoundStates
    /\ roundCutoff \in 0..MaxVersion
    /\ roundBudget \in 0..MaxVersion
    /\ roundProcessed \in 0..MaxVersion
    /\ intentState \in IntentStates
    /\ intentMembers \subseteq issued
    /\ intentGeneration \in 0..MaxGeneration
    /\ cosStored \in BOOLEAN
    /\ unsafeCutoffChange \in BOOLEAN
    /\ unsafePostCutoff \in BOOLEAN
    /\ unsafeEvict \in BOOLEAN
    /\ unsafeComplete \in BOOLEAN

HeadsAuthentic ==
    \A block \in Blocks :
        head[block] = NoObj
        \/ /\ head[block] \in issued
           /\ head[block].block = block

RoundShapeValid ==
    /\ ((roundState = "Idle") =>
           /\ roundCutoff = 0
           /\ roundBudget = 0
           /\ roundProcessed = 0)
    /\ ((roundState = "Active") =>
           /\ roundCutoff > 0
           /\ roundBudget > 0
           /\ roundProcessed <= roundBudget)
    /\ ((intentState = "Missing") =>
           /\ intentMembers = {}
           /\ intentGeneration = 0
           /\ ~cosStored)
    /\ ((intentState # "Missing") =>
           /\ roundState = "Active"
           /\ intentMembers # {}
           /\ intentGeneration > 0
           /\ Cardinality(intentMembers) <= roundBudget - roundProcessed)

AllLiveDataRecoverable ==
    \A object \in LiveObjects : Recoverable(object)

PostCutoffWritesExcluded ==
    \A object \in intentMembers : object.version <= roundCutoff

RoundCutoffStable == ~unsafeCutoffChange
NoPostCutoffAdmission == ~unsafePostCutoff
NoUnsafeHotEviction == ~unsafeEvict
NoEarlyRoundCompletion == ~unsafeComplete

Safety ==
    /\ TypeOK
    /\ HeadsAuthentic
    /\ RoundShapeValid
    /\ AllLiveDataRecoverable
    /\ PostCutoffWritesExcluded
    /\ RoundCutoffStable
    /\ NoPostCutoffAdmission
    /\ NoUnsafeHotEviction
    /\ NoEarlyRoundCompletion

=============================================================================
