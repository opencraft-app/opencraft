------------------------ MODULE RetentionLifecycle ------------------------
EXTENDS FiniteSets

CONSTANTS Ops, Versions, Intents, Rounds, Mutation

ASSUME /\ Ops # {}
       /\ Versions # {}
       /\ Intents # {}
       /\ Rounds # {}
       /\ Mutation \in {
            "None",
            "DeleteOpenResult",
            "DeleteReferencedVersion",
            "DeleteActiveIntent",
            "DeleteActiveRound"
          }

VARIABLES
    retryOpen,
    epochRetired,
    opResults,
    referencedVersions,
    versionRows,
    activeIntents,
    completedIntents,
    intentRound,
    activeRounds,
    completedRounds,
    unsafeResultGc,
    unsafeVersionGc,
    unsafeIntentGc,
    unsafeRoundGc

vars == <<
    retryOpen,
    epochRetired,
    opResults,
    referencedVersions,
    versionRows,
    activeIntents,
    completedIntents,
    intentRound,
    activeRounds,
    completedRounds,
    unsafeResultGc,
    unsafeVersionGc,
    unsafeIntentGc,
    unsafeRoundGc
>>

InitialIntent == CHOOSE intent \in Intents : TRUE
InitialRound == CHOOSE round \in Rounds : TRUE

Init ==
    /\ retryOpen = Ops
    /\ epochRetired = {}
    /\ opResults = Ops
    /\ referencedVersions = Versions
    /\ versionRows = Versions
    /\ activeIntents = {InitialIntent}
    /\ completedIntents = {}
    /\ intentRound = [intent \in Intents |-> InitialRound]
    /\ activeRounds = {InitialRound}
    /\ completedRounds = {}
    /\ unsafeResultGc = FALSE
    /\ unsafeVersionGc = FALSE
    /\ unsafeIntentGc = FALSE
    /\ unsafeRoundGc = FALSE

CloseRetry(op) ==
    /\ op \in retryOpen
    /\ retryOpen' = retryOpen \ {op}
    /\ UNCHANGED <<
           epochRetired, opResults, referencedVersions, versionRows,
           activeIntents, completedIntents, intentRound, activeRounds,
           completedRounds, unsafeResultGc, unsafeVersionGc,
           unsafeIntentGc, unsafeRoundGc
       >>

RetireEpoch(op) ==
    /\ op \notin retryOpen
    /\ op \notin epochRetired
    /\ epochRetired' = epochRetired \cup {op}
    /\ UNCHANGED <<
           retryOpen, opResults, referencedVersions, versionRows,
           activeIntents, completedIntents, intentRound, activeRounds,
           completedRounds, unsafeResultGc, unsafeVersionGc,
           unsafeIntentGc, unsafeRoundGc
       >>

ResultGcSafe(op) ==
    /\ op \notin retryOpen
    /\ op \in epochRetired

GcResult(op) ==
    /\ op \in opResults
    /\ (ResultGcSafe(op) \/ Mutation = "DeleteOpenResult")
    /\ opResults' = opResults \ {op}
    /\ unsafeResultGc' = IF ResultGcSafe(op) THEN unsafeResultGc ELSE TRUE
    /\ UNCHANGED <<
           retryOpen, epochRetired, referencedVersions, versionRows,
           activeIntents, completedIntents, intentRound, activeRounds,
           completedRounds, unsafeVersionGc, unsafeIntentGc, unsafeRoundGc
       >>

DropReference(version) ==
    /\ version \in referencedVersions
    /\ referencedVersions' = referencedVersions \ {version}
    /\ UNCHANGED <<
           retryOpen, epochRetired, opResults, versionRows, activeIntents,
           completedIntents, intentRound, activeRounds, completedRounds,
           unsafeResultGc, unsafeVersionGc, unsafeIntentGc, unsafeRoundGc
       >>

GcVersion(version) ==
    /\ version \in versionRows
    /\ (version \notin referencedVersions \/ Mutation = "DeleteReferencedVersion")
    /\ versionRows' = versionRows \ {version}
    /\ unsafeVersionGc' =
           IF version \in referencedVersions THEN TRUE ELSE unsafeVersionGc
    /\ UNCHANGED <<
           retryOpen, epochRetired, opResults, referencedVersions,
           activeIntents, completedIntents, intentRound, activeRounds,
           completedRounds, unsafeResultGc, unsafeIntentGc, unsafeRoundGc
       >>

CompleteIntent(intent) ==
    /\ intent \in activeIntents
    /\ activeIntents' = activeIntents \ {intent}
    /\ completedIntents' = completedIntents \cup {intent}
    /\ UNCHANGED <<
           retryOpen, epochRetired, opResults, referencedVersions,
           versionRows, intentRound, activeRounds, completedRounds,
           unsafeResultGc, unsafeVersionGc, unsafeIntentGc, unsafeRoundGc
       >>

GcIntent(intent) ==
    /\ intent \in activeIntents \cup completedIntents
    /\ (intent \in completedIntents \/ Mutation = "DeleteActiveIntent")
    /\ activeIntents' = activeIntents \ {intent}
    /\ completedIntents' = completedIntents \ {intent}
    /\ unsafeIntentGc' =
           IF intent \in activeIntents THEN TRUE ELSE unsafeIntentGc
    /\ UNCHANGED <<
           retryOpen, epochRetired, opResults, referencedVersions,
           versionRows, intentRound, activeRounds, completedRounds,
           unsafeResultGc, unsafeVersionGc, unsafeRoundGc
       >>

CompleteRound(round) ==
    /\ round \in activeRounds
    /\ ~\E intent \in activeIntents : intentRound[intent] = round
    /\ activeRounds' = activeRounds \ {round}
    /\ completedRounds' = completedRounds \cup {round}
    /\ UNCHANGED <<
           retryOpen, epochRetired, opResults, referencedVersions,
           versionRows, activeIntents, completedIntents, intentRound,
           unsafeResultGc, unsafeVersionGc, unsafeIntentGc, unsafeRoundGc
       >>

RoundGcSafe(round) ==
    /\ round \in completedRounds
    /\ ~\E intent \in activeIntents \cup completedIntents :
           intentRound[intent] = round

GcRound(round) ==
    /\ round \in activeRounds \cup completedRounds
    /\ (RoundGcSafe(round) \/ Mutation = "DeleteActiveRound")
    /\ activeRounds' = activeRounds \ {round}
    /\ completedRounds' = completedRounds \ {round}
    /\ unsafeRoundGc' =
           IF round \in activeRounds THEN TRUE ELSE unsafeRoundGc
    /\ UNCHANGED <<
           retryOpen, epochRetired, opResults, referencedVersions,
           versionRows, activeIntents, completedIntents, intentRound,
           unsafeResultGc, unsafeVersionGc, unsafeIntentGc
       >>

Next ==
    \/ \E op \in Ops : CloseRetry(op)
    \/ \E op \in Ops : RetireEpoch(op)
    \/ \E op \in Ops : GcResult(op)
    \/ \E version \in Versions : DropReference(version)
    \/ \E version \in Versions : GcVersion(version)
    \/ \E intent \in Intents : CompleteIntent(intent)
    \/ \E intent \in Intents : GcIntent(intent)
    \/ \E round \in Rounds : CompleteRound(round)
    \/ \E round \in Rounds : GcRound(round)

Spec == Init /\ [][Next]_vars

=============================================================================
