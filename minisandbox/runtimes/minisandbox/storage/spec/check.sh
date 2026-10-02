#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TLA_VERSION="1.7.2"
readonly TLA_SHA1="7f21faa2cdae3189e7d5fadb4488f0dfcc658407"
readonly TLA_SHA256="fa18543e44ed5974a85bd2c60c0dc16620ae117680ea8e693d2691999ed90b22"
readonly CACHE_DIR="${SCRIPT_DIR}/.cache"
readonly TLA_JAR="${TLA2TOOLS_JAR:-${CACHE_DIR}/tla2tools-${TLA_VERSION}.jar}"

usage() {
    echo "usage: $0 [quick|ci|medium|full|mutations|all]"
}

require_java() {
    if ! command -v java >/dev/null 2>&1; then
        echo "error: Java 11 or newer is required" >&2
        exit 1
    fi
}

fetch_tlc() {
    if [[ ! -f "${TLA_JAR}" ]]; then
        if [[ -n "${TLA2TOOLS_JAR:-}" ]]; then
            echo "error: TLA2TOOLS_JAR does not exist: ${TLA_JAR}" >&2
            exit 1
        fi
        mkdir -p "${CACHE_DIR}"
        curl -fL \
            "https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar" \
            -o "${TLA_JAR}.partial"
        mv "${TLA_JAR}.partial" "${TLA_JAR}"
    fi

    local sha1 sha256
    sha1="$(sha1sum "${TLA_JAR}")"
    sha1="${sha1%% *}"
    sha256="$(sha256sum "${TLA_JAR}")"
    sha256="${sha256%% *}"
    if [[ "${sha1}" != "${TLA_SHA1}" || "${sha256}" != "${TLA_SHA256}" ]]; then
        echo "error: unexpected tla2tools.jar checksums:" >&2
        echo "  SHA-1:   ${sha1}" >&2
        echo "  SHA-256: ${sha256}" >&2
        exit 1
    fi
}

new_run_root() {
    TLA_RUN_ROOT="$(mktemp -d /data/tmp/minisandbox-storage-tla.XXXXXX)"
    case "${TLA_RUN_ROOT}" in
        /data/tmp/minisandbox-storage-tla.*) ;;
        *) echo "error: unsafe temporary path: ${TLA_RUN_ROOT}" >&2; exit 1 ;;
    esac
    readonly TLA_RUN_ROOT
}

cleanup() {
    if [[ "${TLA_RUN_ROOT:-}" == /data/tmp/minisandbox-storage-tla.* ]]; then
        rm -rf -- "${TLA_RUN_ROOT}"
    fi
}

run_model() {
    local name="$1"
    local config="$2"
    echo "MODEL ${name} config=${config}"
    java -XX:+UseParallelGC -jar "${TLA_JAR}" \
        -workers auto \
        -metadir "${TLA_RUN_ROOT}/${name}" \
        -config "${config}" \
        "${SCRIPT_DIR}/StorageSafety.tla"
}

run_mutation() {
    local name="$1"
    local invariant="$2"
    local output="${TLA_RUN_ROOT}/${name}.log"

    if java -XX:+UseParallelGC -jar "${TLA_JAR}" \
        -workers 1 \
        -metadir "${TLA_RUN_ROOT}/${name}" \
        -config "${SCRIPT_DIR}/mutations/${name}.cfg" \
        "${SCRIPT_DIR}/StorageSafety.tla" >"${output}" 2>&1; then
        echo "error: mutation ${name} unexpectedly satisfied ${invariant}" >&2
        exit 1
    fi

    if ! grep -Fq "Invariant ${invariant} is violated" "${output}"; then
        echo "error: mutation ${name} failed for an unexpected reason" >&2
        sed -n '1,120p' "${output}" >&2
        exit 1
    fi
    echo "MUTATION_OK name=${name} counterexample=${invariant}"
}

run_mutations() {
    run_mutation AckBeforeSync AcknowledgedDataRecoverable
    run_mutation CommitBeforeObjects ManifestObjectsExist
    run_mutation ReclaimBeforeManifest AcknowledgedDataRecoverable
    run_mutation AcceptStaleWrite StaleEpochsAreFenced
    run_mutation AcceptStaleCommit ManifestNeverRegresses
}

main() {
    local mode="${1:-quick}"
    if [[ $# -gt 1 ]]; then
        usage >&2
        exit 1
    fi

    require_java
    fetch_tlc
    new_run_root
    trap cleanup EXIT

    case "${mode}" in
        quick) run_model quick "${SCRIPT_DIR}/StorageQuick.cfg" ;;
        ci)
            run_model quick "${SCRIPT_DIR}/StorageQuick.cfg"
            run_mutations
            ;;
        medium) run_model medium "${SCRIPT_DIR}/StorageCI.cfg" ;;
        full) run_model full "${SCRIPT_DIR}/Storage.cfg" ;;
        mutations) run_mutations ;;
        all)
            run_model full "${SCRIPT_DIR}/Storage.cfg"
            run_mutations
            ;;
        *) usage >&2; exit 1 ;;
    esac
}

main "$@"
