#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PARENT_SPEC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly TLA_VERSION="1.7.2"
readonly TLA_SHA1="7f21faa2cdae3189e7d5fadb4488f0dfcc658407"
readonly TLA_SHA256="fa18543e44ed5974a85bd2c60c0dc16620ae117680ea8e693d2691999ed90b22"
readonly TLA_JAR="${TLA2TOOLS_JAR:-${PARENT_SPEC_DIR}/.cache/tla2tools-${TLA_VERSION}.jar}"

usage() {
    echo "usage: $0 [quick|lifecycle|cbs|sqlite|mutations|all]"
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
    TLA_RUN_ROOT="$(mktemp -d /tmp/minisandbox-metastore-tla.XXXXXX)"
    case "${TLA_RUN_ROOT}" in
        /tmp/minisandbox-metastore-tla.*) ;;
        *) echo "error: unsafe temporary path: ${TLA_RUN_ROOT}" >&2; exit 1 ;;
    esac
    readonly TLA_RUN_ROOT
}

cleanup() {
    if [[ "${TLA_RUN_ROOT:-}" == /tmp/minisandbox-metastore-tla.* ]]; then
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
        sed -n '1,160p' "${output}" >&2
        exit 1
    fi
    echo "MUTATION_OK name=${name} counterexample=${invariant}"
}

run_mutations() {
    run_mutation MetaLifecycle ForkWithoutPin RefCountsExact
    run_mutation MetaLifecycle DeleteReferencedRoot NoReferencedRootIsDeleted
    run_mutation MetaLifecycle MissingGcOutbox GcHasTransactionalOutbox
    run_mutation MetaLifecycle PublishAfterDelete NoPublishAfterDelete
    run_mutation MetaLifecycle RetryDoubleRelease RefCountsExact
    run_mutation CbsTxnLog AckBeforeSync AcknowledgedTransactionsRecover
    run_mutation CbsTxnLog CommitBeforeData CommittedMemoryIsDurable
    run_mutation CbsTxnLog AcceptTornRecord TornRecordsAreRejected
    run_mutation CbsTxnLog DuplicateRetry OperationIdsCommitAtMostOnce
    run_mutation SqliteMetaStoreSafety SqliteAckBeforeCommit AcknowledgementsAreDurable
    run_mutation SqliteMetaStoreSafety SqliteMissingDedupe OperationsApplyAtMostOnce
    run_mutation SqliteMetaStoreSafety SqliteMissingEpochGuard StaleEpochsAreFenced
    run_mutation SqliteMetaStoreSafety SqliteMissingConditionalGuard ConditionalWritesAreAtomic
    run_mutation SqliteMetaStoreSafety SqliteReuseCommitVersion CommitVersionsLinear
    run_mutation SqliteMetaStoreSafety SqliteStaleRead ReadsRespectRealTime
}

main() {
    local mode="${1:-quick}"
    [[ $# -le 1 ]] || { usage >&2; exit 1; }

    require_tools
    new_run_root
    trap cleanup EXIT

    case "${mode}" in
        quick)
            run_model lifecycle MetaLifecycle MetaLifecycleQuick.cfg
            run_model sqlite-quick SqliteMetaStoreSafety SqliteMetaStoreQuick.cfg
            ;;
        lifecycle)
            run_model lifecycle-full MetaLifecycle MetaLifecycle.cfg
            ;;
        cbs)
            run_model cbs CbsTxnLog CbsTxnLog.cfg
            ;;
        sqlite)
            run_model sqlite SqliteMetaStoreSafety SqliteMetaStoreCI.cfg
            ;;
        mutations)
            run_mutations
            ;;
        all)
            run_model lifecycle-full MetaLifecycle MetaLifecycle.cfg
            run_model cbs CbsTxnLog CbsTxnLog.cfg
            run_model sqlite SqliteMetaStoreSafety SqliteMetaStoreCI.cfg
            run_mutations
            ;;
        *) usage >&2; exit 1 ;;
    esac
}

main "$@"
