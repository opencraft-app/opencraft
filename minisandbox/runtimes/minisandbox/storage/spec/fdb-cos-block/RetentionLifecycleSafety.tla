--------------------- MODULE RetentionLifecycleSafety ---------------------
EXTENDS RetentionLifecycle

TypeOK ==
    /\ retryOpen \subseteq Ops
    /\ epochRetired \subseteq Ops
    /\ opResults \subseteq Ops
    /\ referencedVersions \subseteq Versions
    /\ versionRows \subseteq Versions
    /\ activeIntents \subseteq Intents
    /\ completedIntents \subseteq Intents
    /\ activeIntents \cap completedIntents = {}
    /\ intentRound \in [Intents -> Rounds]
    /\ activeRounds \subseteq Rounds
    /\ completedRounds \subseteq Rounds
    /\ activeRounds \cap completedRounds = {}
    /\ unsafeResultGc \in BOOLEAN
    /\ unsafeVersionGc \in BOOLEAN
    /\ unsafeIntentGc \in BOOLEAN
    /\ unsafeRoundGc \in BOOLEAN

OpenRetriesKeepResults ==
    \A op \in retryOpen : op \in opResults

ReferencedVersionsRetained ==
    referencedVersions \subseteq versionRows

ActiveIntentsRetained == ~unsafeIntentGc

ActiveRoundsRetained == ~unsafeRoundGc

NoUnsafeResultGc == ~unsafeResultGc

NoUnsafeVersionGc == ~unsafeVersionGc

Safety ==
    /\ TypeOK
    /\ OpenRetriesKeepResults
    /\ ReferencedVersionsRetained
    /\ ActiveIntentsRetained
    /\ ActiveRoundsRetained
    /\ NoUnsafeResultGc
    /\ NoUnsafeVersionGc

=============================================================================
