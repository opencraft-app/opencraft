package manifests

import (
	"os"
	"strings"
	"testing"
)

func TestRunnerRBACAndJobKeepPrivilegesAndSecretsNarrow(t *testing.T) {
	infrastructure := read(t, "infrastructure.yaml")
	job := read(t, "job.yaml.template")

	for _, required := range []string{
		"resourceNames: [llmgateway-traffic]", "verbs: [get, patch]",
		"resources: [replicasets]", "resources: [pods]", "resources: [poddisruptionbudgets]", "resources: [leases]", "verbs: [create]",
		"resources: [configmaps]", "verbs: [get, create]",
	} {
		if !strings.Contains(infrastructure, required) {
			t.Fatalf("infrastructure missing %q", required)
		}
	}
	if strings.Contains(infrastructure, "resources: [jobs]") || strings.Contains(infrastructure, "verbs: [\"*\"]") {
		t.Fatal("runner RBAC must not write Jobs or use wildcard verbs")
	}
	for _, required := range []string{
		"secretKeyRef:", "key: CLUSTER_ADMIN_TOKEN", "key: INTERNAL_SERVICE_TOKEN",
		"serviceAccountName: ${SERVICE_ACCOUNT}", "/usr/local/bin/llmgateway-regression-runner",
		"mockURL: ${MOCK_URL}", "pinnedStreamHeadroom: ${PINNED_STREAM_HEADROOM}",
		"targetReleaseID: ${TARGET_RELEASE_ID}", "expectedRings: ${EXPECTED_RINGS_JSON}",
		"managerImage: ${MANAGER_IMAGE}", "pollInterval: ${DISRUPTION_POLL_INTERVAL}",
	} {
		if !strings.Contains(job, required) {
			t.Fatalf("job template missing %q", required)
		}
	}
	if strings.Contains(job, "adminToken:") || strings.Contains(job, "internalToken:") {
		t.Fatal("secret values must not be represented in runner YAML")
	}
}

func TestDisruptiveRBACIsSeparatedFromDefaultRunner(t *testing.T) {
	manifest := read(t, "disruptive-rbac.yaml")
	for _, required := range []string{
		"name: llmgateway-regression-disruptive", "resources: [cronjobs]", "resourceNames: [llmgateway-set-manager]",
		"resources: [jobs]", "verbs: [get, list, create, delete]", "name: llmgateway-regression-runner",
		"resources: [deployments]\n    verbs: [get]",
		"apiGroups: [policy]\n    resources: [poddisruptionbudgets]\n    verbs: [get]",
		"resources: [deployments]", "llmgateway-control", "llmgateway-worker-admin", "llmgateway-worker-observer",
		"resources: [pods]", "verbs: [delete]",
		"kind: ClusterRole", "resources: [nodes]", "kind: ClusterRoleBinding", "${NODE_READER_NAME}",
	} {
		if !strings.Contains(manifest, required) {
			t.Fatalf("disruptive RBAC missing %q", required)
		}
	}
	if strings.Contains(manifest, "resourceNames: [llmgateway-traffic]") {
		t.Fatal("control-plane outage RBAC must not scale the traffic deployment")
	}
	if strings.Contains(manifest, "resources: [deployments]\n    verbs: [get, patch]") {
		t.Fatal("disruptive runner may read dynamic Set deployments but must not patch them")
	}
}

func TestJobTemplateCarriesControlPlaneOutageConfiguration(t *testing.T) {
	job := read(t, "job.yaml.template")
	for _, required := range []string{
		"controlPlaneOutage:", "controlDeployment: ${OUTAGE_CONTROL_DEPLOYMENT}",
		"workerDeployments: ${OUTAGE_WORKER_DEPLOYMENTS_JSON}", "backlogJob: ${OUTAGE_BACKLOG_JOB}",
		"outageDuration: ${OUTAGE_DURATION}", "minimumSamples: ${OUTAGE_MIN_SAMPLES}",
	} {
		if !strings.Contains(job, required) {
			t.Fatalf("job template missing %q", required)
		}
	}
}

func TestPacerIsAStableDeploymentFixture(t *testing.T) {
	infrastructure := read(t, "infrastructure.yaml")
	for _, required := range []string{
		"name: llmgateway-regression-pacer", "app: llmgateway-regression-pacer",
		"/usr/local/bin/llmgateway-regression-pacer", "value: ${SSE_DURATION}",
		"value: ${LONG_STREAM_MODEL}", "${PACER_UPSTREAM}",
	} {
		if !strings.Contains(infrastructure, required) {
			t.Fatalf("pacer fixture missing %q", required)
		}
	}
	runScript := read(t, "../run.sh")
	if !strings.Contains(runScript, `("NAMESPACE", "LLMGATEWAY_IMAGE", "PACER_UPSTREAM", "SSE_DURATION", "LONG_STREAM_MODEL")`) {
		t.Fatal("run.sh must render pacer duration and model from the same run configuration")
	}
}

func TestBootstrapPreservesLongStreamModelForPacerRouting(t *testing.T) {
	bootstrap := read(t, "../bootstrap-fixtures.sh")
	if !strings.Contains(bootstrap, `"llmgw-regression-long": "llmgw-regression-long"`) {
		t.Fatal("bootstrap must preserve the long stream model name for pacer routing")
	}
	if !strings.Contains(bootstrap, `"llmgw-regression-upgrade-probe": "llmgw-regression-upgrade-probe"`) {
		t.Fatal("bootstrap must preserve the isolated upgrade probe model for fault injection")
	}
	for _, required := range []string{"golden-channels", "ModelRatio", "CompletionRatio", "/api/sets", "/api/channel-bundles/regression-mock-channel/apply"} {
		if !strings.Contains(bootstrap, required) {
			t.Fatalf("bootstrap must inherit pricing and converge every active Set, missing %q", required)
		}
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
