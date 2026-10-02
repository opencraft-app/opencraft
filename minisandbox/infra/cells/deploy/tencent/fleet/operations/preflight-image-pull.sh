#!/usr/bin/env bash
set -euo pipefail

kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
namespace=${ACTOR_IMAGE_PREFLIGHT_NAMESPACE:?ACTOR_IMAGE_PREFLIGHT_NAMESPACE is required}
name=${ACTOR_IMAGE_PREFLIGHT_NAME:?ACTOR_IMAGE_PREFLIGHT_NAME is required}
image=${ACTOR_IMAGE_PREFLIGHT_IMAGE:?ACTOR_IMAGE_PREFLIGHT_IMAGE must be pinned by registry digest}
pull_secret=${ACTOR_IMAGE_PREFLIGHT_PULL_SECRET:?ACTOR_IMAGE_PREFLIGHT_PULL_SECRET is required}
node_selector=${ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR:?ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR is required}
timeout_seconds=${ACTOR_IMAGE_PREFLIGHT_TIMEOUT_SECONDS:-180}
expected_exit_code=${ACTOR_IMAGE_PREFLIGHT_EXPECTED_EXIT_CODE:-0}
required_output=${ACTOR_IMAGE_PREFLIGHT_REQUIRED_OUTPUT:-}

[[ $name =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#name} -le 45 ]] || { echo "invalid image preflight name" >&2; exit 2; }
[[ $image =~ @sha256:[0-9a-f]{64}$ ]] || { echo "image preflight requires an immutable registry digest" >&2; exit 2; }
[[ $pull_secret =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || { echo "invalid image pull Secret name" >&2; exit 2; }
[[ $timeout_seconds =~ ^[1-9][0-9]*$ ]] || { echo "image preflight timeout must be a positive integer" >&2; exit 2; }
[[ $expected_exit_code =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]] || { echo "image preflight expected exit code must be between 0 and 255" >&2; exit 2; }
(( ${#required_output} <= 4096 )) || { echo "image preflight required output is too large" >&2; exit 2; }
[[ $# -gt 0 ]] || { echo "image preflight requires a safe probe command" >&2; exit 2; }

kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "$pull_secret" >/dev/null
nodes=$(kubectl "${kubeconfig_args[@]}" get nodes -l "$node_selector" -o json)
node_count=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("items",[])))' <<<"$nodes")
((node_count > 0)) || { echo "image preflight selector matched no nodes" >&2; exit 1; }

selector="fleet.actor.dev/image-preflight=$name"
kubectl "${kubeconfig_args[@]}" -n "$namespace" delete pods -l "$selector" --ignore-not-found --wait=true >/dev/null
cleanup() {
	kubectl "${kubeconfig_args[@]}" -n "$namespace" delete pods -l "$selector" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

python3 - "$namespace" "$name" "$image" "$pull_secret" "$@" 3<<<"$nodes" <<'PY' \
	| kubectl "${kubeconfig_args[@]}" apply -f - >/dev/null
import hashlib,json,os,sys
namespace,name,image,pull_secret,*command=sys.argv[1:]
items=[]
for node in json.load(os.fdopen(3)).get("items",[]):
    node_name=node["metadata"]["name"]
    suffix=hashlib.sha256(node_name.encode()).hexdigest()[:10]
    pod_name=f"{name}-{suffix}"
    items.append({
      "apiVersion":"v1","kind":"Pod",
      "metadata":{"name":pod_name,"namespace":namespace,
        "labels":{"app.kubernetes.io/name":"actor-image-preflight","fleet.actor.dev/image-preflight":name}},
      "spec":{"nodeName":node_name,"restartPolicy":"Never","automountServiceAccountToken":False,
        "imagePullSecrets":[{"name":pull_secret}],"terminationGracePeriodSeconds":1,
        "securityContext":{"runAsNonRoot":True,"runAsUser":65532,"runAsGroup":65532,"seccompProfile":{"type":"RuntimeDefault"}},
        "containers":[{"name":"probe","image":image,"imagePullPolicy":"Always","command":command,
          "resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"128Mi"}},
          "securityContext":{"allowPrivilegeEscalation":False,"readOnlyRootFilesystem":True,"capabilities":{"drop":["ALL"]}}}]}}
    )
print(json.dumps({"apiVersion":"v1","kind":"List","items":items},separators=(",",":")))
PY

deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
	pods=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods -l "$selector" -o json)
	result=$(python3 - "$node_count" "$expected_exit_code" 3<<<"$pods" <<'PY'
import json,os,sys
expected=int(sys.argv[1]); expected_exit=int(sys.argv[2]); pods=json.load(os.fdopen(3)).get("items",[])
if len(pods)!=expected:
    print("waiting"); raise SystemExit
terminal=0
for pod in pods:
    statuses=pod.get("status",{}).get("containerStatuses",[])
    if not statuses:
        continue
    state=statuses[0].get("state",{})
    if "terminated" in state:
        if state["terminated"].get("exitCode") != expected_exit:
            print("failed"); raise SystemExit
        terminal+=1
        continue
    waiting=state.get("waiting",{})
    # A Pod bound directly with spec.nodeName can reach kubelet before the
    # Node authorizer's Pod/Secret relationship cache has converged.  Kubelet
    # reports ErrImagePull/ImagePullBackOff in that window, then retries with
    # the same Secret successfully.  Keep polling those retriable states;
    # invalid pod/image configuration is terminal and should still fail fast.
    if waiting.get("reason") in {"InvalidImageName","CreateContainerConfigError","RunContainerError"}:
        print("failed"); raise SystemExit
print("passed" if terminal==expected else "waiting")
PY
	)
	case "$result" in
	passed)
		if [[ -n $required_output ]]; then
			mapfile -t pod_names < <(kubectl "${kubeconfig_args[@]}" -n "$namespace" \
				get pods -l "$selector" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
			((${#pod_names[@]} == node_count)) || {
				echo "image preflight output verification found an incomplete Pod set" >&2
				break
			}
			output_ok=true
			for pod_name in "${pod_names[@]}"; do
				logs=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" logs "$pod_name" -c probe) || {
					output_ok=false
					break
				}
				while IFS= read -r expected; do
					[[ -z $expected ]] || grep -Fq -- "$expected" <<<"$logs" || {
						echo "image preflight Pod $pod_name lacks required output: $expected" >&2
						output_ok=false
						break
					}
				done <<<"$required_output"
				[[ $output_ok == true ]] || break
			done
			[[ $output_ok == true ]] || break
		fi
		printf 'image_preflight=passed image=%s nodes=%s expected_exit_code=%s\n' "$image" "$node_count" "$expected_exit_code"
		cleanup
		trap - EXIT INT TERM
		exit 0
		;;
	failed) break ;;
	esac
	sleep 2
done

echo "immutable image did not pull and execute on every selected node" >&2
kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods -l "$selector" -o wide >&2 || true
kubectl "${kubeconfig_args[@]}" -n "$namespace" describe pods -l "$selector" >&2 || true
exit 1
