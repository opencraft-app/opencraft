#!/usr/bin/env bash
set -euo pipefail

readonly TLA_VERSION="1.7.2"
readonly TLA_SHA1="7f21faa2cdae3189e7d5fadb4488f0dfcc658407"
readonly TLA_SHA256="fa18543e44ed5974a85bd2c60c0dc16620ae117680ea8e693d2691999ed90b22"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SHARED_CACHE_DIR="${SCRIPT_DIR}/../../../storage/spec/.cache"
readonly TLA_JAR="${TLA2TOOLS_JAR:-${SHARED_CACHE_DIR}/tla2tools-${TLA_VERSION}.jar}"

usage() {
    echo "usage: $0 [quick|ci|ci-twice|mutations|all]"
}

fetch_tlc() {
    mkdir -p "$(dirname "${TLA_JAR}")"
    if [[ ! -f "${TLA_JAR}" ]]; then
        curl --fail --location --silent --show-error \
            "https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar" \
            --output "${TLA_JAR}"
    fi

    local sha1 sha256
    sha1="$(sha1sum "${TLA_JAR}" | awk '{print $1}')"
    sha256="$(sha256sum "${TLA_JAR}" | awk '{print $1}')"
    if [[ "${sha1}" != "${TLA_SHA1}" || "${sha256}" != "${TLA_SHA256}" ]]; then
        echo "error: unexpected TLA+ Tools checksum" >&2
        exit 1
    fi
}

run_model() {
    local name="$1"
    local fingerprint="$2"
    java -XX:+UseParallelGC -jar "${TLA_JAR}" \
        -workers auto \
        -fp "${fingerprint}" \
        -metadir "${TLA_RUN_ROOT}/${name}-fp${fingerprint}" \
        -config "${SCRIPT_DIR}/${name}.cfg" \
        "${SCRIPT_DIR}/ActorVolumeFenceSafety.tla"
}

run_mutation() {
    local name="$1"
    local invariant="$2"
    local output
    output="${TLA_RUN_ROOT}/${name}.log"
    if java -XX:+UseParallelGC -jar "${TLA_JAR}" \
        -workers 1 \
        -metadir "${TLA_RUN_ROOT}/mutation-${name}" \
        -config "${SCRIPT_DIR}/mutations/${name}.cfg" \
        "${SCRIPT_DIR}/ActorVolumeFenceSafety.tla" >"${output}" 2>&1; then
        echo "error: mutation ${name} unexpectedly satisfied ${invariant}" >&2
        exit 1
    fi
    if ! grep -Fq "Invariant ${invariant} is violated" "${output}"; then
        echo "error: mutation ${name} failed for an unexpected reason" >&2
        sed -n '1,220p' "${output}" >&2
        exit 1
    fi
    echo "caught ${name} with ${invariant}"
}

run_mutations() {
    run_mutation AcquireWithoutGenerationFence WriterAcquisitionsAreGenerationFenced
    run_mutation CommitWithoutPegboardFence CommittedWritesHeldAuthorityFence
    run_mutation AdmitBeforeWriterFence AdmissionsCarryWriterFence
    run_mutation ReturnIngressAfterRevocation ReturnedIngressWasLiveAndExact
    run_mutation StopWrongGeneration StopTargetsExactGeneration
    run_mutation ReuseCapability ActiveCapabilitiesNeverRetired
    run_mutation CompleteStopBeforeTeardown StopCompletionAfterTeardown
    run_mutation ReplayUnknownBeforeFence ReplayedResultsWereGenerationFenced
}

main() {
    local mode="${1:-quick}"
    fetch_tlc
    TLA_RUN_ROOT="$(mktemp -d /tmp/minisandbox-actor-volume-tla.XXXXXX)"
    case "${TLA_RUN_ROOT}" in
        /tmp/minisandbox-actor-volume-tla.*) ;;
        *) echo "error: unsafe TLA+ temporary path" >&2; exit 1 ;;
    esac
    readonly TLA_RUN_ROOT
    trap 'rm -rf -- "${TLA_RUN_ROOT}"' EXIT
    case "${mode}" in
        quick) run_model ActorVolumeFenceQuick 23 ;;
        ci) run_model ActorVolumeFenceCI 29 ;;
        ci-twice)
            run_model ActorVolumeFenceCI 29
            run_model ActorVolumeFenceCI 47
            ;;
        mutations) run_mutations ;;
        all)
            run_model ActorVolumeFenceQuick 23
            run_model ActorVolumeFenceCI 29
            run_model ActorVolumeFenceCI 47
            run_mutations
            ;;
        *)
            usage >&2
            exit 1
            ;;
    esac
}

main "$@"
