-------------------- MODULE PackIntentLifecycle --------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Objects, Intents, MaxGeneration, Mutation

ASSUME /\ Objects # {}
       /\ Intents # {}
       /\ MaxGeneration \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "ReselectAfterCrash",
            "PublishBeforeVerify",
            "EvictBeforePublish",
            "StaleGenerationPublish",
            "CompleteBeforeEvict"
          }

IntentStates == {"Missing", "Prepared", "Verified", "Published", "Complete"}
NoIntent == "NoIntent"

VARIABLES
    running,
    generation,
    intentState,
    intentMembers,
    intentGeneration,
    reservedBy,
    cosStored,
    location,
    hot,
    unsafeReselect,
    unsafePublish,
    unsafeEvict,
    unsafeStalePublish,
    unsafeComplete

vars == <<
    running,
    generation,
    intentState,
    intentMembers,
    intentGeneration,
    reservedBy,
    cosStored,
    location,
    hot,
    unsafeReselect,
    unsafePublish,
    unsafeEvict,
    unsafeStalePublish,
    unsafeComplete
>>

IntentActive(intent) == intentState[intent] \in {"Prepared", "Verified", "Published"}

ColdDurable(object) ==
    LET intent == location[object] IN
    /\ intent # NoIntent
    /\ intentState[intent] \in {"Published", "Complete"}
    /\ intent \in cosStored
    /\ object \in intentMembers[intent]

Init ==
    /\ running = TRUE
    /\ generation = 1
    /\ intentState = [intent \in Intents |-> "Missing"]
    /\ intentMembers = [intent \in Intents |-> {}]
    /\ intentGeneration = [intent \in Intents |-> 0]
    /\ reservedBy = [object \in Objects |-> NoIntent]
    /\ cosStored = {}
    /\ location = [object \in Objects |-> NoIntent]
    /\ hot = Objects
    /\ unsafeReselect = FALSE
    /\ unsafePublish = FALSE
    /\ unsafeEvict = FALSE
    /\ unsafeStalePublish = FALSE
    /\ unsafeComplete = FALSE

PrepareIntent(intent, members) ==
    /\ running
    /\ intentState[intent] = "Missing"
    /\ members \in SUBSET hot
    /\ members # {}
    /\ \A object \in members : reservedBy[object] = NoIntent
    /\ intentState' = [intentState EXCEPT ![intent] = "Prepared"]
    /\ intentMembers' = [intentMembers EXCEPT ![intent] = members]
    /\ intentGeneration' = [intentGeneration EXCEPT ![intent] = generation]
    /\ reservedBy' =
           [object \in Objects |->
               IF object \in members THEN intent ELSE reservedBy[object]]
    /\ UNCHANGED <<
           running, generation, cosStored, location, hot,
           unsafeReselect, unsafePublish, unsafeEvict,
           unsafeStalePublish, unsafeComplete
       >>

PutApplied(intent) ==
    /\ running
    /\ intentState[intent] = "Prepared"
    /\ intentGeneration[intent] = generation
    /\ cosStored' = cosStored \cup {intent}
    /\ UNCHANGED <<
           running, generation, intentState, intentMembers,
           intentGeneration, reservedBy, location, hot,
           unsafeReselect, unsafePublish, unsafeEvict,
           unsafeStalePublish, unsafeComplete
       >>

VerifyIntent(intent) ==
    /\ running
    /\ intentState[intent] = "Prepared"
    /\ intentGeneration[intent] = generation
    /\ intent \in cosStored
    /\ intentState' = [intentState EXCEPT ![intent] = "Verified"]
    /\ UNCHANGED <<
           running, generation, intentMembers, intentGeneration,
           reservedBy, cosStored, location, hot, unsafeReselect,
           unsafePublish, unsafeEvict, unsafeStalePublish, unsafeComplete
       >>

PublishIntent(intent) ==
    /\ running
    /\ intentState[intent] \in {"Prepared", "Verified"}
    /\ \/ /\ intentState[intent] = "Verified"
           /\ intent \in cosStored
       \/ Mutation = "PublishBeforeVerify"
    /\ \/ intentGeneration[intent] = generation
       \/ Mutation = "StaleGenerationPublish"
    /\ location' =
           [object \in Objects |->
               IF object \in intentMembers[intent]
               THEN intent
               ELSE location[object]]
    /\ intentState' = [intentState EXCEPT ![intent] = "Published"]
    /\ unsafePublish' =
           (unsafePublish \/
            ~(intentState[intent] = "Verified" /\ intent \in cosStored))
    /\ unsafeStalePublish' =
           (unsafeStalePublish \/
            intentGeneration[intent] # generation)
    /\ UNCHANGED <<
           running, generation, intentMembers, intentGeneration,
           reservedBy, cosStored, hot, unsafeReselect, unsafeEvict,
           unsafeComplete
       >>

EvictHot(object) ==
    /\ running
    /\ object \in hot
    /\ \/ ColdDurable(object)
       \/ Mutation = "EvictBeforePublish"
    /\ hot' = hot \ {object}
    /\ unsafeEvict' = (unsafeEvict \/ ~ColdDurable(object))
    /\ UNCHANGED <<
           running, generation, intentState, intentMembers,
           intentGeneration, reservedBy, cosStored, location,
           unsafeReselect, unsafePublish, unsafeStalePublish, unsafeComplete
       >>

CompleteIntent(intent) ==
    /\ running
    /\ intentState[intent] = "Published"
    /\ \/ intentMembers[intent] \cap hot = {}
       \/ Mutation = "CompleteBeforeEvict"
    /\ intentState' = [intentState EXCEPT ![intent] = "Complete"]
    /\ unsafeComplete' =
           (unsafeComplete \/ intentMembers[intent] \cap hot # {})
    /\ UNCHANGED <<
           running, generation, intentMembers, intentGeneration,
           reservedBy, cosStored, location, hot, unsafeReselect,
           unsafePublish, unsafeEvict, unsafeStalePublish
       >>

Crash ==
    /\ running
    /\ running' = FALSE
    /\ UNCHANGED <<
           generation, intentState, intentMembers, intentGeneration,
           reservedBy, cosStored, location, hot, unsafeReselect,
           unsafePublish, unsafeEvict, unsafeStalePublish, unsafeComplete
       >>

Recover ==
    /\ ~running
    /\ generation < MaxGeneration
    /\ running' = TRUE
    /\ generation' = generation + 1
    /\ UNCHANGED <<
           intentState, intentMembers, intentGeneration, reservedBy,
           cosStored, location, hot, unsafeReselect, unsafePublish,
           unsafeEvict, unsafeStalePublish, unsafeComplete
       >>

ClaimIntent(intent) ==
    /\ running
    /\ IntentActive(intent)
    /\ intentGeneration[intent] < generation
    /\ intentGeneration' = [intentGeneration EXCEPT ![intent] = generation]
    /\ UNCHANGED <<
           running, generation, intentState, intentMembers, reservedBy,
           cosStored, location, hot, unsafeReselect, unsafePublish,
           unsafeEvict, unsafeStalePublish, unsafeComplete
       >>

ReselectIntent(intent, members) ==
    /\ Mutation = "ReselectAfterCrash"
    /\ running
    /\ IntentActive(intent)
    /\ intentGeneration[intent] < generation
    /\ members \in SUBSET hot
    /\ members # {}
    /\ members # intentMembers[intent]
    /\ intentMembers' = [intentMembers EXCEPT ![intent] = members]
    /\ unsafeReselect' = TRUE
    /\ UNCHANGED <<
           running, generation, intentState, intentGeneration, reservedBy,
           cosStored, location, hot, unsafePublish, unsafeEvict,
           unsafeStalePublish, unsafeComplete
       >>

Next ==
    \/ \E intent \in Intents, members \in SUBSET Objects :
           PrepareIntent(intent, members)
    \/ \E intent \in Intents : PutApplied(intent)
    \/ \E intent \in Intents : VerifyIntent(intent)
    \/ \E intent \in Intents : PublishIntent(intent)
    \/ \E object \in Objects : EvictHot(object)
    \/ \E intent \in Intents : CompleteIntent(intent)
    \/ Crash
    \/ Recover
    \/ \E intent \in Intents : ClaimIntent(intent)
    \/ \E intent \in Intents, members \in SUBSET Objects :
           ReselectIntent(intent, members)

Spec == Init /\ [][Next]_vars

=====================================================================
