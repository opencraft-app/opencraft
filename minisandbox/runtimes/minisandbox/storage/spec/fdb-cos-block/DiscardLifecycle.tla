---------------------- MODULE DiscardLifecycle ----------------------
EXTENDS Naturals

CONSTANTS Ops, MaxVersion, MaxGeneration, Mutation

ASSUME /\ Ops # {}
       /\ MaxVersion \in Nat \ {0}
       /\ MaxGeneration \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "DiscardWithoutVersion",
            "DiscardMutatesSnapshot",
            "ReturnFailureAsZero",
            "StaleDiscard"
          }

Kinds == {"Missing", "Data", "Discard"}
ReadKinds == {"None", "Data", "Zero", "Error"}

VARIABLES
    running,
    generation,
    nextVersion,
    currentVersion,
    versionKind,
    snapshots,
    opResult,
    lastRead,
    unsafeNoVersion,
    unsafeSnapshotMutation,
    unsafeFailureZero,
    unsafeStaleDiscard

vars == <<
    running,
    generation,
    nextVersion,
    currentVersion,
    versionKind,
    snapshots,
    opResult,
    lastRead,
    unsafeNoVersion,
    unsafeSnapshotMutation,
    unsafeFailureZero,
    unsafeStaleDiscard
>>

Init ==
    /\ running = TRUE
    /\ generation = 1
    /\ nextVersion = 1
    /\ currentVersion = 0
    /\ versionKind = [version \in 1..MaxVersion |-> "Missing"]
    /\ snapshots = {}
    /\ opResult = [op \in Ops |-> 0]
    /\ lastRead = "None"
    /\ unsafeNoVersion = FALSE
    /\ unsafeSnapshotMutation = FALSE
    /\ unsafeFailureZero = FALSE
    /\ unsafeStaleDiscard = FALSE

Write(op) ==
    /\ running
    /\ opResult[op] = 0
    /\ nextVersion <= MaxVersion
    /\ versionKind' = [versionKind EXCEPT ![nextVersion] = "Data"]
    /\ currentVersion' = nextVersion
    /\ opResult' = [opResult EXCEPT ![op] = nextVersion]
    /\ nextVersion' = nextVersion + 1
    /\ UNCHANGED <<
           running, generation, snapshots, lastRead, unsafeNoVersion,
           unsafeSnapshotMutation, unsafeFailureZero, unsafeStaleDiscard
       >>

Discard(op) ==
    /\ running
    /\ opResult[op] = 0
    /\ nextVersion <= MaxVersion
    /\ IF Mutation = "DiscardWithoutVersion"
          THEN /\ opResult' = [opResult EXCEPT ![op] = currentVersion]
               /\ unsafeNoVersion' = TRUE
               /\ UNCHANGED <<nextVersion, currentVersion, versionKind>>
          ELSE /\ versionKind' =
                       [version \in 1..MaxVersion |->
                           IF Mutation = "DiscardMutatesSnapshot" /\ version \in snapshots
                           THEN "Discard"
                           ELSE IF version = nextVersion
                                THEN "Discard"
                                ELSE versionKind[version]]
               /\ currentVersion' = nextVersion
               /\ opResult' = [opResult EXCEPT ![op] = nextVersion]
               /\ nextVersion' = nextVersion + 1
               /\ unsafeNoVersion' = unsafeNoVersion
    /\ unsafeSnapshotMutation' =
           (unsafeSnapshotMutation \/
            (Mutation = "DiscardMutatesSnapshot" /\ snapshots # {}))
    /\ UNCHANGED <<
           running, generation, snapshots, lastRead,
           unsafeFailureZero, unsafeStaleDiscard
       >>

Retry(op) ==
    /\ running
    /\ opResult[op] # 0
    /\ UNCHANGED vars

CreateSnapshot ==
    /\ running
    /\ currentVersion # 0
    /\ snapshots' = snapshots \cup {currentVersion}
    /\ UNCHANGED <<
           running, generation, nextVersion, currentVersion, versionKind,
           opResult, lastRead, unsafeNoVersion, unsafeSnapshotMutation,
           unsafeFailureZero, unsafeStaleDiscard
       >>

ReadVersion(version) ==
    /\ running
    /\ version \in {currentVersion} \cup snapshots
    /\ version # 0
    /\ lastRead' = IF versionKind[version] = "Data" THEN "Data" ELSE "Zero"
    /\ UNCHANGED <<
           running, generation, nextVersion, currentVersion, versionKind,
           snapshots, opResult, unsafeNoVersion, unsafeSnapshotMutation,
           unsafeFailureZero, unsafeStaleDiscard
       >>

ReadAbsent ==
    /\ running
    /\ currentVersion = 0
    /\ lastRead' = "Zero"
    /\ UNCHANGED <<
           running, generation, nextVersion, currentVersion, versionKind,
           snapshots, opResult, unsafeNoVersion, unsafeSnapshotMutation,
           unsafeFailureZero, unsafeStaleDiscard
       >>

ReadFailure ==
    /\ running
    /\ currentVersion # 0
    /\ lastRead' = IF Mutation = "ReturnFailureAsZero" THEN "Zero" ELSE "Error"
    /\ unsafeFailureZero' =
           (unsafeFailureZero \/ Mutation = "ReturnFailureAsZero")
    /\ UNCHANGED <<
           running, generation, nextVersion, currentVersion, versionKind,
           snapshots, opResult, unsafeNoVersion, unsafeSnapshotMutation,
           unsafeStaleDiscard
       >>

Crash ==
    /\ running
    /\ running' = FALSE
    /\ UNCHANGED <<
           generation, nextVersion, currentVersion, versionKind, snapshots,
           opResult, lastRead, unsafeNoVersion, unsafeSnapshotMutation,
           unsafeFailureZero, unsafeStaleDiscard
       >>

Recover ==
    /\ ~running
    /\ generation < MaxGeneration
    /\ running' = TRUE
    /\ generation' = generation + 1
    /\ UNCHANGED <<
           nextVersion, currentVersion, versionKind, snapshots, opResult,
           lastRead, unsafeNoVersion, unsafeSnapshotMutation,
           unsafeFailureZero, unsafeStaleDiscard
       >>

DiscardFromStaleGeneration(op, oldGeneration) ==
    /\ Mutation = "StaleDiscard"
    /\ running
    /\ oldGeneration \in 1..MaxGeneration
    /\ oldGeneration < generation
    /\ opResult[op] = 0
    /\ nextVersion <= MaxVersion
    /\ versionKind' = [versionKind EXCEPT ![nextVersion] = "Discard"]
    /\ currentVersion' = nextVersion
    /\ opResult' = [opResult EXCEPT ![op] = nextVersion]
    /\ nextVersion' = nextVersion + 1
    /\ unsafeStaleDiscard' = TRUE
    /\ UNCHANGED <<
           running, generation, snapshots, lastRead, unsafeNoVersion,
           unsafeSnapshotMutation, unsafeFailureZero
       >>

Next ==
    \/ \E op \in Ops : Write(op)
    \/ \E op \in Ops : Discard(op)
    \/ \E op \in Ops : Retry(op)
    \/ CreateSnapshot
    \/ \E version \in 1..MaxVersion : ReadVersion(version)
    \/ ReadAbsent
    \/ ReadFailure
    \/ Crash
    \/ Recover
    \/ \E op \in Ops, oldGeneration \in 1..MaxGeneration :
           DiscardFromStaleGeneration(op, oldGeneration)

Spec == Init /\ [][Next]_vars

=====================================================================
