----------------- MODULE PackIntentLifecycleSafety -----------------
EXTENDS PackIntentLifecycle

TypeOK ==
    /\ running \in BOOLEAN
    /\ generation \in 1..MaxGeneration
    /\ intentState \in [Intents -> IntentStates]
    /\ intentMembers \in [Intents -> SUBSET Objects]
    /\ intentGeneration \in [Intents -> 0..MaxGeneration]
    /\ reservedBy \in [Objects -> Intents \cup {NoIntent}]
    /\ cosStored \subseteq Intents
    /\ location \in [Objects -> Intents \cup {NoIntent}]
    /\ hot \subseteq Objects
    /\ unsafeReselect \in BOOLEAN
    /\ unsafePublish \in BOOLEAN
    /\ unsafeEvict \in BOOLEAN
    /\ unsafeStalePublish \in BOOLEAN
    /\ unsafeComplete \in BOOLEAN

IntentShapeValid ==
    \A intent \in Intents :
        /\ (intentState[intent] = "Missing") = (intentMembers[intent] = {})
        /\ (intentState[intent] = "Missing") = (intentGeneration[intent] = 0)

ReservationsExact ==
    \A object \in Objects :
        reservedBy[object] # NoIntent
        => object \in intentMembers[reservedBy[object]]

LocationsAuthentic ==
    \A object \in Objects :
        location[object] # NoIntent
        => /\ object \in intentMembers[location[object]]
           /\ intentState[location[object]] \in {"Published", "Complete"}
           /\ location[object] \in cosStored

EveryObjectRecoverable ==
    \A object \in Objects : object \in hot \/ ColdDurable(object)

CompletedIntentsFinished ==
    \A intent \in Intents :
        intentState[intent] = "Complete"
        => /\ intentMembers[intent] \cap hot = {}
           /\ \A object \in intentMembers[intent] : location[object] = intent

IntentMembershipImmutable == ~unsafeReselect
NoUnverifiedPublication == ~unsafePublish
NoUnsafeHotEviction == ~unsafeEvict
StaleGenerationsFenced == ~unsafeStalePublish
NoEarlyCompletion == ~unsafeComplete

Safety ==
    /\ TypeOK
    /\ IntentShapeValid
    /\ ReservationsExact
    /\ LocationsAuthentic
    /\ EveryObjectRecoverable
    /\ CompletedIntentsFinished
    /\ IntentMembershipImmutable
    /\ NoUnverifiedPublication
    /\ NoUnsafeHotEviction
    /\ StaleGenerationsFenced
    /\ NoEarlyCompletion

=====================================================================
