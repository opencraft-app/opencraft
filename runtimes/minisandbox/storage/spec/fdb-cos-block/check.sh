#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PARENT_SPEC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly TLA_VERSION="1.7.2"
readonly TLA_SHA1="7f21faa2cdae3189e7d5fadb4488f0dfcc658407"
readonly TLA_SHA256="fa18543e44ed5974a85bd2c60c0dc16620ae117680ea8e693d2691999ed90b22"
readonly TLA_JAR="${TLA2TOOLS_JAR:-${PARENT_SPEC_DIR}/.cache/tla2tools-${TLA_VERSION}.jar}"

usage() {
    echo "usage: $0 [quick|ci|pack-ci|intent-ci|round-ci|discard-ci|gc-ci|read-ci|root-ci|txn-ci|volume-txn-ci|delta-ci|batch-ci|retention-ci|volume-txn-mutations|delta-mutations|batch-mutations|round-mutations|retention-mutations|mutations|all]"
}

require_tools() {
    command -v java >/dev/null 2>&1 || {
        echo "error: Java 11 or newer is required" >&2
        exit 1
    }
    [[ -f "${TLA_JAR}" ]] || {
        echo "error: pinned TLC jar missing; run ../check.sh quick first" >&2
        exit 1
    }

    local sha1 sha256
    sha1="$(sha1sum "${TLA_JAR}")"
    sha1="${sha1%% *}"
    sha256="$(sha256sum "${TLA_JAR}")"
    sha256="${sha256%% *}"
    if [[ "${sha1}" != "${TLA_SHA1}" || "${sha256}" != "${TLA_SHA256}" ]]; then
        echo "error: unexpected TLC checksum" >&2
        exit 1
    fi
}

new_run_root() {
    TLA_RUN_ROOT="$(mktemp -d /tmp/minisandbox-fdb-cos-tla.XXXXXX)"
    case "${TLA_RUN_ROOT}" in
        /tmp/minisandbox-fdb-cos-tla.*) ;;
        *) echo "error: unsafe temporary path: ${TLA_RUN_ROOT}" >&2; exit 1 ;;
    esac
    readonly TLA_RUN_ROOT
}

cleanup() {
    if [[ "${TLA_RUN_ROOT:-}" == /tmp/minisandbox-fdb-cos-tla.* ]]; then
        rm -rf -- "${TLA_RUN_ROOT}"
    fi
}

run_model() {
    local name="$1"
    local module="$2"
    local config="$3"
    echo "MODEL ${name} config=${config}"
    java -XX:+UseParallelGC -jar "${TLA_JAR}" \
        -workers auto \
        -metadir "${TLA_RUN_ROOT}/${name}" \
        -config "${SCRIPT_DIR}/${config}" \
        "${SCRIPT_DIR}/${module}.tla"
}

run_mutation() {
    local module="$1"
    local name="$2"
    local invariant="$3"
    local output="${TLA_RUN_ROOT}/${name}.log"

    if java -XX:+UseParallelGC -jar "${TLA_JAR}" \
        -workers 1 \
        -metadir "${TLA_RUN_ROOT}/${name}" \
        -config "${SCRIPT_DIR}/mutations/${name}.cfg" \
        "${SCRIPT_DIR}/${module}.tla" >"${output}" 2>&1; then
        echo "error: mutation ${name} unexpectedly satisfied ${invariant}" >&2
        exit 1
    fi

    if ! grep -Fq "Invariant ${invariant} is violated" "${output}"; then
        echo "error: mutation ${name} failed for an unexpected reason" >&2
        sed -n '1,140p' "${output}" >&2
        exit 1
    fi
    echo "MUTATION_OK name=${name} counterexample=${invariant}"
}

run_delta_mutations() {
    run_mutation DeltaMapLifecycleSafety DeltaRewriteLayerEveryWrite SteadyWritesKeepLayerPointer
    run_mutation DeltaMapLifecycleSafety DeltaSnapshotMutable SnapshotsImmutable
    run_mutation DeltaMapLifecycleSafety DeltaMutateSealed SnapshotsImmutable
    run_mutation DeltaMapLifecycleSafety DeltaMissingEpochFence StaleEpochsFenced
    run_mutation DeltaMapLifecycleSafety DeltaWrongKeyWrite WritesChangeOnlyAddressedDelta
    run_mutation DeltaMapLifecycleSafety DeltaWriteRetiredVolume RetiredVolumesAreFenced
    run_mutation DeltaMapLifecycleSafety DeltaForkDeletedSnapshot DeletedSnapshotsCannotFork
    run_mutation DeltaMapLifecycleSafety DeltaReuseDeletedVolume DeletedVolumeIncarnationsNeverReused
    run_mutation DeltaMapLifecycleSafety DeltaDeleteSnapshotCascadesVolumes SnapshotDeletionPreservesForks
    run_mutation DeltaMapLifecycleSafety DeltaDeleteVolumeCascadesSnapshots VolumeDeletionPreservesSnapshots
}

run_volume_txn_mutations() {
    run_mutation VolumeTxnLifecycleSafety VolumeTxnMissingVolumeConflict LateCommitsAreFenced
    run_mutation VolumeTxnLifecycleSafety VolumeTxnMissingOpConflict OperationsApplyAtMostOnce
    run_mutation VolumeTxnLifecycleSafety VolumeTxnDeleteNoEpochAdvance DeleteFenceAndRootReleaseAreAtomic
    run_mutation VolumeTxnLifecycleSafety VolumeTxnDeleteOutboxNotAtomic DeleteFenceAndRootReleaseAreAtomic
    run_mutation VolumeTxnLifecycleSafety VolumeTxnDeleteReplyBeforeCommit DeleteAcknowledgementsAreDurable
    run_mutation VolumeTxnLifecycleSafety VolumeTxnDeleteDoubleRelease DeleteFenceAndRootReleaseAreAtomic
    run_mutation VolumeTxnLifecycleSafety VolumeTxnRetryCloseBeforeFence RetryClosureRequiresFence
    run_mutation VolumeTxnLifecycleSafety VolumeTxnReuseRetiredIncarnation RetiredIncarnationsNeverReactivate
    run_mutation VolumeTxnLifecycleSafety VolumeTxnGcResultBeforeFence ResultGcRequiresClosedWindow
}

run_batch_mutations() {
    run_mutation BatchCommitLifecycleSafety BatchPartialCommit BatchResultsAreAtomic
    run_mutation BatchCommitLifecycleSafety BatchAckBeforeCommit AcknowledgementsAreDurable
    run_mutation BatchCommitLifecycleSafety BatchIgnoreEpochFence StaleEpochsAreFenced
}

run_round_mutations() {
    run_mutation SettlementRoundLifecycleSafety RoundAdvanceCutoffAfterCrash RoundCutoffStable
    run_mutation SettlementRoundLifecycleSafety RoundAdmitPostCutoff PostCutoffWritesExcluded
    run_mutation SettlementRoundLifecycleSafety RoundEvictBeforePublish NoUnsafeHotEviction
    run_mutation SettlementRoundLifecycleSafety RoundCompleteEarly NoEarlyRoundCompletion
}

run_retention_mutations() {
    run_mutation RetentionLifecycleSafety RetentionDeleteOpenResult OpenRetriesKeepResults
    run_mutation RetentionLifecycleSafety RetentionDeleteReferencedVersion ReferencedVersionsRetained
    run_mutation RetentionLifecycleSafety RetentionDeleteActiveIntent ActiveIntentsRetained
    run_mutation RetentionLifecycleSafety RetentionDeleteActiveRound ActiveRoundsRetained
}

run_mutations() {
    run_mutation FdbCosBlockSafety AckFlushEarly AcknowledgedFlushRecoverable
    run_mutation FdbCosBlockSafety AcceptStaleCommit StaleEpochsAreFenced
    run_mutation FdbCosBlockSafety PublishUnverifiedCos NoUnverifiedCosPublication
    run_mutation FdbCosBlockSafety EvictBeforePublish NoUnsafeHotEviction
    run_mutation FdbCosBlockSafety EvictPinnedSnapshot NoUnsafeHotEviction
    run_mutation FdbCosBlockSafety BlindRetryUnknown UnknownCommitsAreIdempotent
    run_mutation PackLifecycleSafety PublishUnverifiedPack NoUnverifiedPublication
    run_mutation PackLifecycleSafety DeleteReferencedPack NoReferencedPackDeletion
    run_mutation PackLifecycleSafety EvictBeforePackPublish NoUnsafeHotEviction
    run_mutation PackLifecycleSafety RewriteImmutablePack PackMembershipImmutable
    run_mutation PackLifecycleSafety RepackGap RepackIsGapFree
    run_mutation PackIntentLifecycleSafety IntentReselectAfterCrash IntentMembershipImmutable
    run_mutation PackIntentLifecycleSafety IntentPublishBeforeVerify NoUnverifiedPublication
    run_mutation PackIntentLifecycleSafety IntentEvictBeforePublish NoUnsafeHotEviction
    run_mutation PackIntentLifecycleSafety IntentStaleGenerationPublish StaleGenerationsFenced
    run_mutation PackIntentLifecycleSafety IntentCompleteBeforeEvict NoEarlyCompletion
    run_mutation DiscardLifecycleSafety DiscardWithoutVersion DiscardCreatesVersion
    run_mutation DiscardLifecycleSafety DiscardMutatesSnapshot SnapshotRootsImmutable
    run_mutation DiscardLifecycleSafety ReturnFailureAsZero ZeroReadsAuthorized
    run_mutation DiscardLifecycleSafety StaleDiscard StaleGenerationsFenced
    run_mutation SnapshotGcLifecycleSafety GcWithoutOutbox TransactionalGcOutbox
    run_mutation SnapshotGcLifecycleSafety DeleteWrongExactKey ExactKeyDeletionOnly
    run_mutation SnapshotGcLifecycleSafety CompleteUnknownDelete DeleteCompletionReflectsTruth
    run_mutation SnapshotGcLifecycleSafety ReferenceDeletingPack NoReferenceResurrection
    run_mutation SnapshotGcLifecycleSafety ListAuthorizesDelete ListNeverAuthorizesDeletion
    run_mutation SnapshotGcLifecycleSafety CountRootAsPackRef ColdLocationReferenceCountsExact
    run_mutation SnapshotGcLifecycleSafety RetryDoubleVolumeRelease ColdLocationReferenceCountsExact
    run_mutation CosReadLifecycleSafety ReturnCorruptBytes ReturnedBytesAuthentic
    run_mutation CosReadLifecycleSafety ReturnMissingAsZero ReturnedBytesAuthentic
    run_mutation RootPackLifecycleSafety IgnoreForkRoot AllReferencedRootDataRecoverable
    run_mutation RootPackLifecycleSafety RootReuseDeletedLayer RetiredLayerIdsNeverReused
    run_mutation RootPackLifecycleSafety RootReuseDeletedSnapshot RetiredSnapshotIdsNeverReused
    run_mutation FdbTxnLifecycleSafety FdbTxnMissingOpConflict OperationsApplyAtMostOnce
    run_mutation FdbTxnLifecycleSafety FdbTxnMissingEpochConflict StaleEpochsAreFenced
    run_mutation FdbTxnLifecycleSafety FdbTxnBlindHeadOverwrite HeadCoversCommittedVersions
    run_mutation FdbTxnLifecycleSafety FdbTxnGcResultEarly ResultsRetainedUntilSafe
    run_mutation FdbTxnLifecycleSafety FdbTxnAckBeforeCommit AcknowledgementsAreDurable
    run_mutation FdbTxnLifecycleSafety FdbTxnSequenceOnlyVersion VersionIdentityUnique
    run_mutation FdbTxnLifecycleSafety FdbTxnCommitUnknownStaysInFlight CommitUnknownIsTerminal
    run_volume_txn_mutations
    run_delta_mutations
    run_batch_mutations
    run_round_mutations
    run_retention_mutations
}

main() {
    local mode="${1:-quick}"
    [[ $# -le 1 ]] || { usage >&2; exit 1; }

    require_tools
    new_run_root
    trap cleanup EXIT

    case "${mode}" in
        quick)
            run_model quick FdbCosBlockSafety FdbCosBlockQuick.cfg
            run_model pack-quick PackLifecycleSafety PackLifecycleQuick.cfg
            run_model intent-quick PackIntentLifecycleSafety PackIntentLifecycleQuick.cfg
            run_model round-quick SettlementRoundLifecycleSafety SettlementRoundLifecycleQuick.cfg
            run_model discard-quick DiscardLifecycleSafety DiscardLifecycleQuick.cfg
            run_model gc-quick SnapshotGcLifecycleSafety SnapshotGcLifecycleQuick.cfg
            run_model read-quick CosReadLifecycleSafety CosReadLifecycleQuick.cfg
            run_model root-quick RootPackLifecycleSafety RootPackLifecycleQuick.cfg
            run_model txn-quick FdbTxnLifecycleSafety FdbTxnLifecycleQuick.cfg
            run_model volume-txn-quick VolumeTxnLifecycleSafety VolumeTxnLifecycleQuick.cfg
            run_model delta-quick DeltaMapLifecycleSafety DeltaMapLifecycleQuick.cfg
            run_model batch-quick BatchCommitLifecycleSafety BatchCommitLifecycleQuick.cfg
            run_model retention-quick RetentionLifecycleSafety RetentionLifecycleQuick.cfg
            ;;
        ci)
            run_model ci FdbCosBlockSafety FdbCosBlockCI.cfg
            run_model pack-ci PackLifecycleSafety PackLifecycleCI.cfg
            run_model intent-ci PackIntentLifecycleSafety PackIntentLifecycleCI.cfg
            run_model round-ci SettlementRoundLifecycleSafety SettlementRoundLifecycleCI.cfg
            run_model discard-ci DiscardLifecycleSafety DiscardLifecycleCI.cfg
            run_model gc-ci SnapshotGcLifecycleSafety SnapshotGcLifecycleCI.cfg
            run_model read-ci CosReadLifecycleSafety CosReadLifecycleCI.cfg
            run_model root-ci RootPackLifecycleSafety RootPackLifecycleCI.cfg
            run_model txn-ci FdbTxnLifecycleSafety FdbTxnLifecycleCI.cfg
            run_model volume-txn-ci VolumeTxnLifecycleSafety VolumeTxnLifecycleCI.cfg
            run_model delta-ci DeltaMapLifecycleSafety DeltaMapLifecycleCI.cfg
            run_model batch-ci BatchCommitLifecycleSafety BatchCommitLifecycleCI.cfg
            run_model retention-ci RetentionLifecycleSafety RetentionLifecycleCI.cfg
            ;;
        pack-ci)
            run_model pack-ci PackLifecycleSafety PackLifecycleCI.cfg
            ;;
        intent-ci)
            run_model intent-ci PackIntentLifecycleSafety PackIntentLifecycleCI.cfg
            ;;
        round-ci)
            run_model round-ci SettlementRoundLifecycleSafety SettlementRoundLifecycleCI.cfg
            ;;
        discard-ci)
            run_model discard-ci DiscardLifecycleSafety DiscardLifecycleCI.cfg
            ;;
        gc-ci)
            run_model gc-ci SnapshotGcLifecycleSafety SnapshotGcLifecycleCI.cfg
            ;;
        read-ci)
            run_model read-ci CosReadLifecycleSafety CosReadLifecycleCI.cfg
            ;;
        root-ci)
            run_model root-ci RootPackLifecycleSafety RootPackLifecycleCI.cfg
            ;;
        txn-ci)
            run_model txn-ci FdbTxnLifecycleSafety FdbTxnLifecycleCI.cfg
            ;;
        volume-txn-ci)
            run_model volume-txn-ci VolumeTxnLifecycleSafety VolumeTxnLifecycleCI.cfg
            ;;
        delta-ci)
            run_model delta-ci DeltaMapLifecycleSafety DeltaMapLifecycleCI.cfg
            ;;
        batch-ci)
            run_model batch-ci BatchCommitLifecycleSafety BatchCommitLifecycleCI.cfg
            ;;
        retention-ci)
            run_model retention-ci RetentionLifecycleSafety RetentionLifecycleCI.cfg
            ;;
        volume-txn-mutations) run_volume_txn_mutations ;;
        delta-mutations) run_delta_mutations ;;
        batch-mutations) run_batch_mutations ;;
        round-mutations) run_round_mutations ;;
        retention-mutations) run_retention_mutations ;;
        mutations) run_mutations ;;
        all)
            run_model ci FdbCosBlockSafety FdbCosBlockCI.cfg
            run_model pack-ci PackLifecycleSafety PackLifecycleCI.cfg
            run_model intent-ci PackIntentLifecycleSafety PackIntentLifecycleCI.cfg
            run_model round-ci SettlementRoundLifecycleSafety SettlementRoundLifecycleCI.cfg
            run_model discard-ci DiscardLifecycleSafety DiscardLifecycleCI.cfg
            run_model gc-ci SnapshotGcLifecycleSafety SnapshotGcLifecycleCI.cfg
            run_model read-ci CosReadLifecycleSafety CosReadLifecycleCI.cfg
            run_model root-ci RootPackLifecycleSafety RootPackLifecycleCI.cfg
            run_model txn-ci FdbTxnLifecycleSafety FdbTxnLifecycleCI.cfg
            run_model volume-txn-ci VolumeTxnLifecycleSafety VolumeTxnLifecycleCI.cfg
            run_model delta-ci DeltaMapLifecycleSafety DeltaMapLifecycleCI.cfg
            run_model batch-ci BatchCommitLifecycleSafety BatchCommitLifecycleCI.cfg
            run_model retention-ci RetentionLifecycleSafety RetentionLifecycleCI.cfg
            run_mutations
            "${SCRIPT_DIR}/../metastore/check.sh" all
            ;;
        *) usage >&2; exit 1 ;;
    esac
}

main "$@"
