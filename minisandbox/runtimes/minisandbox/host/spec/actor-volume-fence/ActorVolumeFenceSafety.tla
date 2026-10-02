---- MODULE ActorVolumeFenceSafety ----
EXTENDS ActorVolumeFence

WriterAcquisitionsAreGenerationFenced ==
    \A epoch \in 1..volume.epoch :
        epochHistory[epoch].ownerGeneration =
            epochHistory[epoch].authorityGeneration

CommittedWritesHeldAuthorityFence ==
    writeOp.state \in {"Committed", "Unknown", "Acknowledged"}
        => /\ writeOp.commitAuthorityGeneration = writeOp.generation
           /\ writeOp.commitAuthorityEpoch = writeOp.epoch

ReplayedResultsWereGenerationFenced ==
    writeOp.replayAuthorityGeneration # NoGeneration
        => /\ writeOp.replayAuthorityGeneration = writeOp.generation
           /\ writeOp.replayAuthorityEpoch = writeOp.epoch

AdmissionsCarryWriterFence ==
    \A instance \in Instances :
        runtime[instance].everAdmitted
            => /\ runtime[instance].admissionEpoch # NoEpoch
               /\ runtime[instance].admissionOwnerInstance = instance
               /\ runtime[instance].admissionOwnerGeneration =
                    runtime[instance].generation
               /\ runtime[instance].admissionAuthorityGeneration =
                    runtime[instance].generation

ReturnedIngressWasLiveAndExact ==
    openOp.state = "Returned"
        => /\ openOp.completionState = "Running"
           /\ openOp.completionCapability = openOp.capability
           /\ openOp.completionGeneration = openOp.generation

StopTargetsExactGeneration ==
    \A instance \in Instances :
        runtime[instance].stopRequestGeneration # NoGeneration
            => runtime[instance].stopRequestGeneration =
                runtime[instance].stopVictimGeneration

ActiveCapabilitiesNeverRetired ==
    \A instance \in Instances :
        runtime[instance].state = "Running"
            => /\ runtime[instance].capability \notin retiredCapabilities
               /\ runtime[instance].capability =
                    CapabilityValue(instance, runtime[instance].incarnation)

StopCompletionAfterTeardown ==
    \A instance \in Instances :
        runtime[instance].stopCompleted
            => runtime[instance].stopCompletionState = "Dead"

=============================================================================
