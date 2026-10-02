#!/usr/bin/env bash
set -euo pipefail

PVM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${PVM_DIR}/lib.sh"

for command in base64 grep jq kubectl; do require_command "${command}"; done

verify_cell() {
	local cell=$1 kubeconfig=$2 deployment reconciler pod node engine_fdb_config pvm_fdb_config
	local engine_image reconciler_image expected_url runner_configs token envoys deadline last_success
	deployment=${cell}-minisandbox-hermes
	reconciler=${cell}-hermes-runner-config
	expected_url="http://${cell}-engine.actor-fdb-cell-system.svc.cluster.local:6421/runner-configs/${PVM_RUNNER_NAME}?namespace=default"
	engine_image=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get deployment \
		"${cell}-engine" -o json | jq -er '.spec.template.spec.containers[] | select(.name == "engine") | .image')
	reconciler_image=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get cronjob \
		"${reconciler}" -o json | jq -er '.spec.jobTemplate.spec.template.spec.containers[] | select(.name == "reconcile") | .image')
	[[ ${reconciler_image} == "${engine_image}" ]] || \
		die "${cell} runner-config reconciler does not use the Engine control-plane image"
	kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get cronjob "${reconciler}" -o json |
		jq -e --arg url "${expected_url}" '
		.spec.schedule == "* * * * *" and
		.spec.suspend != true and
		.spec.concurrencyPolicy == "Forbid" and
		.spec.successfulJobsHistoryLimit == 1 and
		.spec.failedJobsHistoryLimit == 2 and
		.spec.jobTemplate.spec.activeDeadlineSeconds == 50 and
		.spec.jobTemplate.spec.backoffLimit == 2 and
		.spec.jobTemplate.spec.template.spec as $pod |
		$pod.restartPolicy == "Never" and
		$pod.automountServiceAccountToken == false and
		$pod.nodeSelector == {"rivet.dev/control":"true"} and
		$pod.tolerations == null and
		$pod.volumes == null and
		$pod.securityContext.runAsNonRoot == true and
		$pod.securityContext.runAsUser == 4059 and
		$pod.securityContext.runAsGroup == 4059 and
		$pod.securityContext.seccompProfile.type == "RuntimeDefault" and
		($pod.containers | length) == 1 and
		($pod.containers[0] as $container |
			$container.name == "reconcile" and
			$container.command == ["/usr/bin/curl"] and
			$container.args == [
				"--fail", "--silent", "--show-error", "--noproxy", "*",
				"--connect-timeout", "2", "--max-time", "5", "--retry", "5",
				"--retry-delay", "1", "--retry-all-errors", "--request", "PUT",
				"--header", "Content-Type: application/json", "--data", "{\"normal\":{}}",
				$url
			] and
			$container.env == null and
			$container.volumeMounts == null and
			$container.securityContext.allowPrivilegeEscalation == false and
			$container.securityContext.readOnlyRootFilesystem == true and
			$container.securityContext.capabilities.drop == ["ALL"] and
			$container.resources.limits == {"cpu":"50m", "memory":"64Mi"})
		' >/dev/null || die "${cell} runner-config reconciler violates its bounded security contract"
	deadline=$((SECONDS + 90))
	while ((SECONDS < deadline)); do
		last_success=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get cronjob \
			"${reconciler}" -o jsonpath='{.status.lastSuccessfulTime}')
		[[ -n ${last_success} ]] && break
		sleep 1
	done
	[[ -n ${last_success} ]] || die "${cell} runner-config reconciler did not succeed within 90 seconds"
	kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" wait \
		deployment/"${deployment}" --for=condition=Available --timeout=30s >/dev/null
	pod=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get pod \
		-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=pvm-runtime" \
		-o jsonpath='{.items[0].metadata.name}')
	[[ -n ${pod} ]] || die "${cell} has no PVM runtime Pod"
	node=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get pod "${pod}" \
		-o jsonpath='{.spec.nodeName}')
	[[ -n ${node} ]] || die "${cell} PVM runtime Pod has no assigned node"
	kubectl_for "${kubeconfig}" get node "${node}" -o json | jq -e '
		.metadata.labels["rivet.dev/compute"] == "true" and
		.metadata.labels["rivet.dev/pvm"] == "true" and
		any(.spec.taints[]?;
			.key == "rivet.dev/compute" and .value == "true" and .effect == "NoSchedule")
	' >/dev/null || die "${cell} PVM runtime escaped the tainted compute-node boundary"
	kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" exec -c sbxlet "${pod}" -- \
		/usr/bin/test -c /dev/kvm
	kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" exec -c sbxlet "${pod}" -- \
		/usr/bin/test -f /var/lib/minisandbox/ready
	kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" exec -c metrics "${pod}" -- \
		/bin/busybox wget -qO- http://127.0.0.1:19083/metrics.txt |
		grep -q '^rivet_minisandbox_active_actors [0-9][0-9]*$' || \
		die "${cell} PVM runtime aggregate metrics are unavailable"
	engine_fdb_config=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get deployment \
		"${cell}-engine" -o json | jq -er '
			[.spec.template.spec.volumes[] | select(.name == "fdb-config") | .configMap.name] |
			if length == 1 then .[0] else error("Engine must mount exactly one fdb-config ConfigMap") end')
	pvm_fdb_config=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get deployment \
		"${deployment}" -o json | jq -er '
			[.spec.template.spec.volumes[] | select(.name == "fdb-config") | .configMap.name] |
			if length == 1 then .[0] else error("PVM runtime must mount exactly one fdb-config ConfigMap") end')
	[[ ${pvm_fdb_config} == "${engine_fdb_config}" ]] || \
		die "${cell} PVM runtime and Engine use different FDB clusters"
	kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get pod "${pod}" -o json |
		jq -e '
		.spec as $pod |
		$pod.containers[] | select(.name == "sbxlet") |
		$pod.nodeSelector["rivet.dev/compute"] == "true" and
		$pod.nodeSelector["rivet.dev/pvm"] == "true" and
		any($pod.tolerations[]?;
			.key == "rivet.dev/compute" and .operator == "Equal" and
			.value == "true" and .effect == "NoSchedule") and
		all($pod.tolerations[]?;
			.key == "rivet.dev/compute" or (.key | startswith("node.kubernetes.io/"))) and
		.securityContext.privileged != true and
			.securityContext.allowPrivilegeEscalation == false and
			.securityContext.readOnlyRootFilesystem == true and
		.securityContext.capabilities.drop == ["ALL"] and
		.resources.limits["rivet.dev/kvm"] == "1" and
		$pod.securityContext.seccompProfile.type == "RuntimeDefault" and
		(any($pod.containers[];
			.name == "metrics" and .env == null and
			.securityContext.allowPrivilegeEscalation == false and
			.securityContext.readOnlyRootFilesystem == true and
			.securityContext.capabilities.drop == ["ALL"] and
			[.volumeMounts[].name] == ["metrics"]))
		' >/dev/null || die "${cell} sbxlet Pod does not satisfy the non-privileged security contract"
	runner_configs=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" exec \
		deployment/"${cell}-engine" -- /usr/bin/curl --fail --silent --show-error \
		"http://127.0.0.1:6421/runner-configs?namespace=default&runner_name=${PVM_RUNNER_NAME}")
	jq -e --arg runner "${PVM_RUNNER_NAME}" \
		'.runner_configs[$runner].normal | type == "object"' <<<"${runner_configs}" >/dev/null || \
		die "${cell} has not converged the ${PVM_RUNNER_NAME} normal runner config"

	token=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get secret "${cell}-runtime-auth" \
		-o jsonpath='{.data.token}' | base64 --decode)
	envoys=$(printf '%s\n' "${token}" | kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" \
		exec -i deployment/"${cell}-engine" -- /bin/bash -ceu '
			IFS= read -r token
			exec /usr/bin/curl --fail --silent --show-error \
				--header "Authorization: Bearer ${token}" \
				"http://127.0.0.1:6420/envoys?namespace=default&name=$1&limit=100"
		' -- "${PVM_RUNNER_NAME}")
	jq -e --arg pool "${PVM_RUNNER_NAME}" '
		any(.envoys[];
			.pool_name == $pool and .stop_ts == null and
			.metadata.runtime == "minisandbox" and
			.metadata.profile == "hermes-v1")
	' <<<"${envoys}" >/dev/null || die "${cell} has no active Hermes PVM Envoy"
	log "${cell}: runner config, restricted reconciler, isolated sbxlet, readiness, and active Envoy verified"
}

while IFS=$'\t' read -r cell _cluster kubeconfig; do
	verify_cell "${cell}" "${kubeconfig}"
done < <(runtime_cells)
