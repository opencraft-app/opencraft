---- MODULE ActorVolumeFence ----
EXTENDS Naturals, FiniteSets

(***************************************************************************
Rivet Actor generation -> ActorVolume writer-epoch composition.

Two physical instances may overlap during failover. Durable safety comes from
checking Pegboard generation and the current volume writer epoch in the same
transaction that changes volume state. Local capabilities protect only sbxlet
handles and ingress races.
***************************************************************************)

CONSTANTS
    Instances,
    MaxGeneration,
    MaxIncarnation,
    MaxVolumeEpoch,
    NoGeneration,
    NoEpoch,
    NoInstance,
    NoCapability,
    MutateAcquireWithoutGenerationFence,
    MutateCommitWithoutPegboardFence,
    MutateAdmitBeforeWriterFence,
    MutateReturnIngressAfterRevocation,
    MutateStopWrongGeneration,
    MutateReuseCapability,
    MutateCompleteStopBeforeTeardown,
    MutateReplayUnknownBeforeFence

ASSUME
    /\ Instances # {}
    /\ MaxGeneration \in Nat \ {0}
    /\ MaxIncarnation \in Nat \ {0}
    /\ MaxVolumeEpoch \in Nat \ {0}
    /\ NoGeneration = 0
    /\ NoEpoch = 0
    /\ NoInstance \notin Instances
    /\ MutateAcquireWithoutGenerationFence \in BOOLEAN
    /\ MutateCommitWithoutPegboardFence \in BOOLEAN
    /\ MutateAdmitBeforeWriterFence \in BOOLEAN
    /\ MutateReturnIngressAfterRevocation \in BOOLEAN
    /\ MutateStopWrongGeneration \in BOOLEAN
    /\ MutateReuseCapability \in BOOLEAN
    /\ MutateCompleteStopBeforeTeardown \in BOOLEAN
    /\ MutateReplayUnknownBeforeFence \in BOOLEAN

Generations == 1..MaxGeneration
Incarnations == 1..MaxIncarnation
VolumeEpochs == 1..MaxVolumeEpoch

InstanceStates == {"Empty", "Running", "Revoked", "Dead"}
OpenStates == {"Idle", "InFlight", "Returned", "Rejected"}
WriteStates == {"Idle", "InFlight", "Committed", "Unknown", "Acknowledged", "Rejected"}
TeardownReasons == {"None", "Stop", "Crash"}

CapabilityValue(instance, incarnation) ==
    [slot |-> instance, incarnation |-> incarnation]

AllCapabilities ==
    {CapabilityValue(instance, incarnation) :
        instance \in Instances, incarnation \in Incarnations}

EmptyRuntime ==
    [state |-> "Empty",
     generation |-> NoGeneration,
     incarnation |-> 0,
     capability |-> NoCapability,
     writerEpoch |-> NoEpoch,
     admitted |-> FALSE,
     everAdmitted |-> FALSE,
     admissionEpoch |-> NoEpoch,
     admissionOwnerInstance |-> NoInstance,
     admissionOwnerGeneration |-> NoGeneration,
     admissionAuthorityGeneration |-> NoGeneration,
     stopRequestGeneration |-> NoGeneration,
     stopVictimGeneration |-> NoGeneration,
     stopCompleted |-> FALSE,
     stopCompletionState |-> "Empty",
     teardownReason |-> "None"]

EmptyOpen ==
    [state |-> "Idle",
     instance |-> NoInstance,
     capability |-> NoCapability,
     generation |-> NoGeneration,
     completionState |-> "Empty",
     completionCapability |-> NoCapability,
     completionGeneration |-> NoGeneration]

EmptyWrite ==
    [state |-> "Idle",
     instance |-> NoInstance,
     generation |-> NoGeneration,
     epoch |-> NoEpoch,
     commitAuthorityGeneration |-> NoGeneration,
     commitAuthorityEpoch |-> NoEpoch,
     replayAuthorityGeneration |-> NoGeneration,
     replayAuthorityEpoch |-> NoEpoch]

VARIABLES
    pegboardGeneration,
    runtime,
    retiredCapabilities,
    volume,
    epochHistory,
    openOp,
    writeOp

vars ==
    <<pegboardGeneration, runtime, retiredCapabilities, volume,
      epochHistory, openOp, writeOp>>

TypeOK ==
    /\ pegboardGeneration \in Generations
    /\ runtime \in
        [Instances ->
            [state : InstanceStates,
             generation : {NoGeneration} \cup Generations,
             incarnation : 0..MaxIncarnation,
             capability : {NoCapability} \cup AllCapabilities,
             writerEpoch : {NoEpoch} \cup VolumeEpochs,
             admitted : BOOLEAN,
             everAdmitted : BOOLEAN,
             admissionEpoch : {NoEpoch} \cup VolumeEpochs,
             admissionOwnerInstance : {NoInstance} \cup Instances,
             admissionOwnerGeneration : {NoGeneration} \cup Generations,
             admissionAuthorityGeneration : {NoGeneration} \cup Generations,
             stopRequestGeneration : {NoGeneration} \cup Generations,
             stopVictimGeneration : {NoGeneration} \cup Generations,
             stopCompleted : BOOLEAN,
             stopCompletionState : InstanceStates,
             teardownReason : TeardownReasons]]
    /\ retiredCapabilities \subseteq AllCapabilities
    /\ volume \in
        [epoch : {NoEpoch} \cup VolumeEpochs,
         ownerInstance : {NoInstance} \cup Instances,
         ownerGeneration : {NoGeneration} \cup Generations]
    /\ epochHistory \in
        [VolumeEpochs ->
            [ownerGeneration : {NoGeneration} \cup Generations,
             authorityGeneration : {NoGeneration} \cup Generations]]
    /\ openOp \in
        [state : OpenStates,
         instance : {NoInstance} \cup Instances,
         capability : {NoCapability} \cup AllCapabilities,
         generation : {NoGeneration} \cup Generations,
         completionState : InstanceStates,
         completionCapability : {NoCapability} \cup AllCapabilities,
         completionGeneration : {NoGeneration} \cup Generations]
    /\ writeOp \in
        [state : WriteStates,
         instance : {NoInstance} \cup Instances,
         generation : {NoGeneration} \cup Generations,
         epoch : {NoEpoch} \cup VolumeEpochs,
         commitAuthorityGeneration : {NoGeneration} \cup Generations,
         commitAuthorityEpoch : {NoEpoch} \cup VolumeEpochs,
         replayAuthorityGeneration : {NoGeneration} \cup Generations,
         replayAuthorityEpoch : {NoEpoch} \cup VolumeEpochs]

Init ==
    /\ pegboardGeneration = 1
    /\ runtime = [instance \in Instances |-> EmptyRuntime]
    /\ retiredCapabilities = {}
    /\ volume =
        [epoch |-> NoEpoch,
         ownerInstance |-> NoInstance,
         ownerGeneration |-> NoGeneration]
    /\ epochHistory =
        [epoch \in VolumeEpochs |->
            [ownerGeneration |-> NoGeneration,
             authorityGeneration |-> NoGeneration]]
    /\ openOp = EmptyOpen
    /\ writeOp = EmptyWrite

AdvanceGeneration ==
    /\ pegboardGeneration < MaxGeneration
    /\ pegboardGeneration' = pegboardGeneration + 1
    /\ UNCHANGED <<runtime, retiredCapabilities, volume,
                    epochHistory, openOp, writeOp>>

StartInstance(instance, generation) ==
    /\ instance \in Instances
    /\ generation \in Generations
    /\ generation <= pegboardGeneration
    /\ runtime[instance].state \in {"Empty", "Dead"}
    /\ runtime[instance].incarnation < MaxIncarnation
    /\ LET nextIncarnation == runtime[instance].incarnation + 1
           freshCapability == CapabilityValue(instance, nextIncarnation)
           selectedCapability ==
               IF MutateReuseCapability /\ runtime[instance].incarnation > 0
               THEN CapabilityValue(instance, 1)
               ELSE freshCapability
       IN runtime' =
            [runtime EXCEPT
                ![instance].state = "Running",
                ![instance].generation = generation,
                ![instance].incarnation = nextIncarnation,
                ![instance].capability = selectedCapability,
                ![instance].writerEpoch = NoEpoch,
                ![instance].admitted = FALSE,
                ![instance].everAdmitted = FALSE,
                ![instance].admissionEpoch = NoEpoch,
                ![instance].admissionOwnerInstance = NoInstance,
                ![instance].admissionOwnerGeneration = NoGeneration,
                ![instance].admissionAuthorityGeneration = NoGeneration,
                ![instance].stopRequestGeneration = NoGeneration,
                ![instance].stopVictimGeneration = NoGeneration,
                ![instance].stopCompleted = FALSE,
                ![instance].stopCompletionState = "Empty",
                ![instance].teardownReason = "None"]
    /\ UNCHANGED <<pegboardGeneration, retiredCapabilities, volume,
                    epochHistory, openOp, writeOp>>

AcquireWriter(instance) ==
    /\ instance \in Instances
    /\ runtime[instance].state = "Running"
    /\ volume.epoch < MaxVolumeEpoch
    /\
        IF MutateAcquireWithoutGenerationFence
        THEN TRUE
        ELSE runtime[instance].generation = pegboardGeneration
    /\ LET nextEpoch == volume.epoch + 1
       IN /\ volume' =
                [epoch |-> nextEpoch,
                 ownerInstance |-> instance,
                 ownerGeneration |-> runtime[instance].generation]
          /\ runtime' =
                [runtime EXCEPT ![instance].writerEpoch = nextEpoch]
          /\ epochHistory' =
                [epochHistory EXCEPT
                    ![nextEpoch] =
                        [ownerGeneration |-> runtime[instance].generation,
                         authorityGeneration |-> pegboardGeneration]]
    /\ UNCHANGED <<pegboardGeneration, retiredCapabilities, openOp, writeOp>>

WriterProof(instance) ==
    /\ runtime[instance].generation = pegboardGeneration
    /\ runtime[instance].writerEpoch # NoEpoch
    /\ runtime[instance].writerEpoch = volume.epoch
    /\ volume.ownerInstance = instance
    /\ volume.ownerGeneration = runtime[instance].generation

AdmitInstance(instance) ==
    /\ instance \in Instances
    /\ runtime[instance].state = "Running"
    /\ ~runtime[instance].admitted
    /\ IF MutateAdmitBeforeWriterFence THEN TRUE ELSE WriterProof(instance)
    /\ runtime' =
        [runtime EXCEPT
            ![instance].admitted = TRUE,
            ![instance].everAdmitted = TRUE,
            ![instance].admissionEpoch = runtime[instance].writerEpoch,
            ![instance].admissionOwnerInstance = volume.ownerInstance,
            ![instance].admissionOwnerGeneration = volume.ownerGeneration,
            ![instance].admissionAuthorityGeneration = pegboardGeneration]
    /\ UNCHANGED <<pegboardGeneration, retiredCapabilities, volume,
                    epochHistory, openOp, writeOp>>

StopInstance(instance, requestedGeneration) ==
    /\ instance \in Instances
    /\ requestedGeneration \in Generations
    /\ runtime[instance].state = "Running"
    /\ IF MutateStopWrongGeneration
       THEN TRUE
       ELSE runtime[instance].generation = requestedGeneration
    /\ runtime' =
        [runtime EXCEPT
            ![instance].state = "Revoked",
            ![instance].admitted = FALSE,
            ![instance].stopRequestGeneration = requestedGeneration,
            ![instance].stopVictimGeneration = runtime[instance].generation,
            ![instance].teardownReason = "Stop"]
    /\ retiredCapabilities' =
        retiredCapabilities \cup {runtime[instance].capability}
    /\ UNCHANGED <<pegboardGeneration, volume, epochHistory, openOp, writeOp>>

CrashInstance(instance) ==
    /\ instance \in Instances
    /\ runtime[instance].state \in {"Running", "Revoked"}
    /\ runtime' =
        [runtime EXCEPT
            ![instance].state = "Dead",
            ![instance].admitted = FALSE,
            ![instance].teardownReason = "Crash"]
    /\ retiredCapabilities' =
        retiredCapabilities \cup {runtime[instance].capability}
    /\ UNCHANGED <<pegboardGeneration, volume, epochHistory, openOp, writeOp>>

FinishTeardown(instance) ==
    /\ instance \in Instances
    /\ runtime[instance].state = "Revoked"
    /\ runtime' = [runtime EXCEPT ![instance].state = "Dead"]
    /\ UNCHANGED <<pegboardGeneration, retiredCapabilities, volume,
                    epochHistory, openOp, writeOp>>

CompleteStop(instance) ==
    /\ instance \in Instances
    /\ runtime[instance].teardownReason = "Stop"
    /\ ~runtime[instance].stopCompleted
    /\ IF MutateCompleteStopBeforeTeardown
       THEN runtime[instance].state \in {"Revoked", "Dead"}
       ELSE runtime[instance].state = "Dead"
    /\ runtime' =
        [runtime EXCEPT
            ![instance].stopCompleted = TRUE,
            ![instance].stopCompletionState = runtime[instance].state]
    /\ UNCHANGED <<pegboardGeneration, retiredCapabilities, volume,
                    epochHistory, openOp, writeOp>>

BeginOpen(instance, presentedCapability) ==
    /\ instance \in Instances
    /\ presentedCapability \in AllCapabilities
    /\ openOp.state = "Idle"
    /\ runtime[instance].state = "Running"
    /\ runtime[instance].admitted
    /\ runtime[instance].capability = presentedCapability
    /\ openOp' =
        [state |-> "InFlight",
         instance |-> instance,
         capability |-> presentedCapability,
         generation |-> runtime[instance].generation,
         completionState |-> "Empty",
         completionCapability |-> NoCapability,
         completionGeneration |-> NoGeneration]
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, writeOp>>

FinishOpen ==
    /\ openOp.state = "InFlight"
    /\ LET instance == openOp.instance
           stillExact ==
               /\ runtime[instance].state = "Running"
               /\ runtime[instance].capability = openOp.capability
               /\ runtime[instance].generation = openOp.generation
       IN openOp' =
            [openOp EXCEPT
                !.state =
                    IF MutateReturnIngressAfterRevocation \/ stillExact
                    THEN "Returned"
                    ELSE "Rejected",
                !.completionState = runtime[instance].state,
                !.completionCapability = runtime[instance].capability,
                !.completionGeneration = runtime[instance].generation]
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, writeOp>>

ResetOpen ==
    /\ openOp.state \in {"Returned", "Rejected"}
    /\ openOp' = EmptyOpen
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, writeOp>>

StartWrite(instance) ==
    /\ instance \in Instances
    /\ writeOp.state = "Idle"
    /\ runtime[instance].state = "Running"
    /\ runtime[instance].admitted
    /\ writeOp' =
        [state |-> "InFlight",
         instance |-> instance,
         generation |-> runtime[instance].generation,
         epoch |-> runtime[instance].writerEpoch,
         commitAuthorityGeneration |-> NoGeneration,
         commitAuthorityEpoch |-> NoEpoch,
         replayAuthorityGeneration |-> NoGeneration,
         replayAuthorityEpoch |-> NoEpoch]
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, openOp>>

EpochFenceMatches ==
    /\ writeOp.epoch # NoEpoch
    /\ writeOp.epoch = volume.epoch
    /\ volume.ownerInstance = writeOp.instance
    /\ volume.ownerGeneration = writeOp.generation

CommitFenceMatches ==
    /\ EpochFenceMatches
    /\ IF MutateCommitWithoutPegboardFence
       THEN TRUE
       ELSE writeOp.generation = pegboardGeneration

CommitWriteKnown ==
    /\ writeOp.state = "InFlight"
    /\ CommitFenceMatches
    /\ writeOp' =
        [writeOp EXCEPT
            !.state = "Committed",
            !.commitAuthorityGeneration = pegboardGeneration,
            !.commitAuthorityEpoch = volume.epoch]
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, openOp>>

CommitWriteUnknown ==
    /\ writeOp.state = "InFlight"
    /\ CommitFenceMatches
    /\ writeOp' =
        [writeOp EXCEPT
            !.state = "Unknown",
            !.commitAuthorityGeneration = pegboardGeneration,
            !.commitAuthorityEpoch = volume.epoch]
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, openOp>>

RejectWrite ==
    /\ writeOp.state = "InFlight"
    /\ ~CommitFenceMatches
    /\ writeOp' = [writeOp EXCEPT !.state = "Rejected"]
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, openOp>>

RetryUnknown ==
    /\ writeOp.state = "Unknown"
    /\ IF MutateReplayUnknownBeforeFence
       THEN TRUE
       ELSE /\ writeOp.generation = pegboardGeneration
            /\ EpochFenceMatches
    /\ writeOp' =
        [writeOp EXCEPT
            !.state = "Acknowledged",
            !.replayAuthorityGeneration = pegboardGeneration,
            !.replayAuthorityEpoch = volume.epoch]
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, openOp>>

RejectStaleRetry ==
    /\ writeOp.state = "Unknown"
    /\ \/ writeOp.generation # pegboardGeneration
       \/ ~EpochFenceMatches
    /\ writeOp' = [writeOp EXCEPT !.state = "Rejected"]
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, openOp>>

ResetWrite ==
    /\ writeOp.state \in {"Committed", "Acknowledged", "Rejected"}
    /\ writeOp' = EmptyWrite
    /\ UNCHANGED <<pegboardGeneration, runtime, retiredCapabilities, volume,
                    epochHistory, openOp>>

Next ==
    \/ AdvanceGeneration
    \/ \E instance \in Instances, generation \in Generations :
           StartInstance(instance, generation)
    \/ \E instance \in Instances : AcquireWriter(instance)
    \/ \E instance \in Instances : AdmitInstance(instance)
    \/ \E instance \in Instances, generation \in Generations :
           StopInstance(instance, generation)
    \/ \E instance \in Instances : CrashInstance(instance)
    \/ \E instance \in Instances : FinishTeardown(instance)
    \/ \E instance \in Instances : CompleteStop(instance)
    \/ \E instance \in Instances, capability \in AllCapabilities :
           BeginOpen(instance, capability)
    \/ FinishOpen
    \/ ResetOpen
    \/ \E instance \in Instances : StartWrite(instance)
    \/ CommitWriteKnown
    \/ CommitWriteUnknown
    \/ RejectWrite
    \/ RetryUnknown
    \/ RejectStaleRetry
    \/ ResetWrite

Spec == Init /\ [][Next]_vars

=============================================================================
