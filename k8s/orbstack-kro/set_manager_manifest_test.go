package orbstackkro

import (
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestSetManagerManifestOwnsRequestAndFactFlow(t *testing.T) {
	raw, err := os.ReadFile("50-set-manager.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"kind: CronJob",
		"/usr/local/bin/llmgateway-set-manager",
		"LLMGATEWAY_SET_MANAGER_FLEET",
		"LLMGATEWAY_SET_MANAGER_SOURCE",
		"key: internal-token",
		`resources: ["llmfleets"]`,
		`verbs: ["get", "patch"]`,
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("set-manager manifest missing %q", want)
		}
	}
	for _, forbidden := range []string{`apiGroups: ["batch"]`, `resources: ["jobs"]`, "LLMGATEWAY_SET_UPGRADE_PRECHECK_TIMEOUT_SECONDS"} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("set-manager manifest must not contain production database precheck capability %q", forbidden)
		}
	}

	docs := decodeYAMLDocuments(t, raw)
	kinds := map[string]bool{}
	for _, doc := range docs {
		kinds[doc["kind"].(string)] = true
	}
	for _, want := range []string{"ServiceAccount", "Role", "RoleBinding", "CronJob"} {
		if !kinds[want] {
			t.Fatalf("set-manager manifest missing %s", want)
		}
	}
}

func TestLocalManifestIncludesAdminWriteWorker(t *testing.T) {
	content, err := os.ReadFile("08-llmgateway-worker.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"name: llmgateway-worker-admin", "value: admin", "LLMGATEWAY_ADMIN_WORKER_LEASE_TTL"} {
		if !strings.Contains(string(content), want) {
			t.Fatalf("local worker manifest missing %q", want)
		}
	}
}

func TestLocalLLMFleetProvidesRuntimeCleanupJob(t *testing.T) {
	raw, err := os.ReadFile("30-llmfleet-rgd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"cleanups: \"[]object\"",
		"id: runtimeCleanupJobs",
		"name: ${cleanup.jobName}",
		"/usr/local/bin/llmgateway-runtime-cleaner",
		"automountServiceAccountToken: false",
		"LLMGATEWAY_CLEANUP_CAPABILITY",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("local LLMFleet cleanup support missing %q", want)
		}
	}
	if strings.Contains(content, "name: ${cleanup.cleanupID + '-' + string(cleanup.attempt)}") {
		t.Fatal("local LLMFleet RGD must not use the external cleanup id as a Kubernetes Job name")
	}
}

func TestControlManifestProvidesConsumerForSetManager(t *testing.T) {
	raw, err := os.ReadFile("06-llmgateway-control.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"kind: Secret",
		"name: llmgateway-control-admin",
		"name: llmgateway-mysql",
		"name: llmgateway-control",
		"llmgateway:local",
		"/usr/local/bin/llmgateway-control",
		"LLMGATEWAY_SQL_DSN",
		"LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL",
		"LLMGATEWAY_TRAFFIC_BASE_URL",
		"NEWAPI_SET_ROOT_PASSWORD",
		"/readyz",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("control manifest missing %q", want)
		}
	}

	docs := decodeYAMLDocuments(t, raw)
	kinds := map[string]int{}
	for _, doc := range docs {
		kinds[doc["kind"].(string)]++
	}
	for _, want := range []string{"Secret", "ConfigMap", "Service", "Deployment"} {
		if kinds[want] == 0 {
			t.Fatalf("control manifest missing %s", want)
		}
	}
}

func TestTrafficManifestProvidesSeparateDataPlane(t *testing.T) {
	raw, err := os.ReadFile("07-llmgateway-traffic.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"name: llmgateway-traffic",
		"llmgateway:local",
		"/usr/local/bin/llmgateway-traffic",
		"LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL",
		"LLMGATEWAY_SET_RUNTIME_ROUTE_REQUIRED",
		"LLMGATEWAY_TRAFFIC_TRANSPORT_DRAIN_TIMEOUT",
		"LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS",
		"LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS_PER_HOST",
		"LLMGATEWAY_UPSTREAM_IDLE_CONN_TIMEOUT",
		"/readyz",
		"replicas: 2",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("traffic manifest missing %q", want)
		}
	}
	for _, unwanted := range []string{"LLMGATEWAY_SQL_DSN", "llmgateway-mysql:3306"} {
		if strings.Contains(content, unwanted) {
			t.Fatalf("traffic manifest must remain Redis-only, found %q", unwanted)
		}
	}
	docs := decodeYAMLDocuments(t, raw)
	kinds := map[string]int{}
	for _, doc := range docs {
		kinds[doc["kind"].(string)]++
	}
	for _, want := range []string{"Service", "Deployment"} {
		if kinds[want] == 0 {
			t.Fatalf("traffic manifest missing %s", want)
		}
	}
}

func TestWorkerManifestWritesRouteSnapshotsToRedis(t *testing.T) {
	raw, err := os.ReadFile("08-llmgateway-worker.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"name: llmgateway-worker-core",
		"name: llmgateway-worker-byok",
		"name: llmgateway-worker-observer",
		"/usr/local/bin/llmgateway-worker",
		"LLMGATEWAY_WORKER_POOL",
		"value: core",
		"value: byok",
		"value: observer",
		"LLMGATEWAY_SQL_DSN",
		"LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL",
		"redis://:test-local-password@shared-redis-a:6379/0",
		"LLMGATEWAY_SET_AUTOSCALER_ENABLED",
		"LLMGATEWAY_SET_AUTOSCALER_MIN_WARM_SETS",
		"LLMGATEWAY_SET_AUTOSCALER_SHARD_REFS",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("worker manifest missing %q", want)
		}
	}
	for _, oldName := range []string{
		"LLMGATEWAY_SET_CAPACITY_ENABLED",
		"LLMGATEWAY_SET_MANAGER_MIN_WARM_SETS",
		"LLMGATEWAY_SET_MANAGER_SHARD_REFS",
	} {
		if strings.Contains(content, oldName) {
			t.Fatalf("worker manifest still contains legacy autoscaler config %q", oldName)
		}
	}
}

func TestK8sTrafficE2EInfrastructureExists(t *testing.T) {
	files := map[string][]string{
		"e2e/00-mock-openai.yaml": {
			"name: llmgateway-e2e-mock-openai",
			"github.com/kagent-dev/mockllm/cmd/mockllm",
			"/v1/chat/completions",
			"reply with ok",
			"llmgateway k8s e2e",
		},
		"e2e/10-traffic-e2e-job.yaml": {
			"name: llmgateway-traffic-e2e",
			"main.go",
			"image: golang:",
			"- go",
			"- run",
			"/api/channel-bundles",
			"/api/users/",
			"/api/admin/users/",
			"add_quota",
			"/_llmgateway_console/",
			"/v1/chat/completions",
			"llmgateway-traffic",
			"llmgateway-control",
		},
		"e2e/run.sh": {
			"kubectl apply",
			"wait_for_job",
			".status.failed",
			"llmgateway-traffic-e2e",
		},
	}
	for path, wants := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		content := string(raw)
		for _, want := range wants {
			if !strings.Contains(content, want) {
				t.Fatalf("%s missing %q", path, want)
			}
		}
	}
}

func TestK8sTrafficE2ERunnerUsesGoInsteadOfPython(t *testing.T) {
	raw, err := os.ReadFile("e2e/10-traffic-e2e-job.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, unwanted := range []string{
		"python:",
		"- python",
		"run.py",
	} {
		if strings.Contains(content, unwanted) {
			t.Fatalf("traffic e2e runner should use Go, found %q", unwanted)
		}
	}
	for _, want := range []string{
		"main.go: |",
		"net/http",
		"func main()",
		"/opt/llmgateway-e2e/main.go",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("traffic e2e Go runner missing %q", want)
		}
	}
}

func TestK8sFreshEnvironmentE2EInfrastructureExists(t *testing.T) {
	raw, err := os.ReadFile("e2e/run-fresh.sh")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"kubectl delete namespace",
		"docker build -t llmgateway:local",
		"00-namespace.yaml",
		"05-shared-infra.yaml",
		"06-llmgateway-control.yaml",
		"07-llmgateway-traffic.yaml",
		"30-llmfleet-rgd.yaml",
		"40-fleet.yaml",
		"50-set-manager.yaml",
		"llmgateway-set-manager-fresh",
		"run.sh",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("fresh e2e script missing %q", want)
		}
	}
}

func TestK8sAutoscaleE2EInfrastructureExists(t *testing.T) {
	files := map[string][]string{
		"e2e/20-autoscale-request-job.yaml": {
			"name: llmgateway-autoscale-request-e2e",
			"/api/admin/set-capacity/reconcile",
			"LLMGATEWAY_E2E_SET_PREFIX",
			"set-e2e",
			"max_users_per_set",
			"min_ready_free_users",
			"LLMGATEWAY_E2E_REDIS_DB_START",
			"LLMGATEWAY_E2E_REDIS_DB_LIMIT",
			"\"redis_db_start\": envInt(\"LLMGATEWAY_E2E_REDIS_DB_START\", 3)",
			"\"redis_db_limit\": envInt(\"LLMGATEWAY_E2E_REDIS_DB_LIMIT\", 16)",
		},
		"e2e/30-traffic-autoscale-e2e-job.yaml": {
			"name: llmgateway-traffic-autoscale-e2e",
			"llmgateway-traffic-e2e",
			"LLMGATEWAY_E2E_REQUIRED_SET_PREFIX",
			"set-e2e",
		},
		"e2e/run-autoscale.sh": {
			"LLMGATEWAY_K8S_AUTOSCALE_SET_PREFIX",
			"SET_PREFIX",
			"LLMGATEWAY_K8S_AUTOSCALE_REDIS_DB_START",
			"LLMGATEWAY_K8S_AUTOSCALE_REDIS_DB_LIMIT",
			"20-autoscale-request-job.yaml",
			"llmgateway-autoscale-request-e2e",
			"llmgateway-set-manager-autoscale",
			"30-traffic-autoscale-e2e-job.yaml",
			"llmgateway-traffic-autoscale-e2e",
		},
	}
	for path, wants := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		content := string(raw)
		for _, want := range wants {
			if !strings.Contains(content, want) {
				t.Fatalf("%s missing %q", path, want)
			}
		}
	}
}

func TestOrbStackKROTopologyDefinesTwoShardsAndFourSets(t *testing.T) {
	raw, err := os.ReadFile("40-fleet.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var fleet struct {
		Spec struct {
			Shards []struct {
				Name string `yaml:"name"`
			} `yaml:"shards"`
			Sets []struct {
				Name     string `yaml:"name"`
				ShardRef string `yaml:"shardRef"`
			} `yaml:"sets"`
		} `yaml:"spec"`
	}
	if err := yaml.Unmarshal(raw, &fleet); err != nil {
		t.Fatal(err)
	}
	if len(fleet.Spec.Shards) != 2 || len(fleet.Spec.Sets) != 4 {
		t.Fatalf("topology shards=%d sets=%d, want 2/4", len(fleet.Spec.Shards), len(fleet.Spec.Sets))
	}
	setsByShard := map[string]int{}
	for _, set := range fleet.Spec.Sets {
		setsByShard[set.ShardRef]++
	}
	if setsByShard["shard-a"] != 2 || setsByShard["shard-b"] != 2 {
		t.Fatalf("sets by shard = %#v, want two per shard", setsByShard)
	}
}

func TestLLMFleetGraphCreatesSetDatabaseBeforeNewAPIStarts(t *testing.T) {
	raw, err := os.ReadFile("30-llmfleet-rgd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"name: ensure-database",
		"image: mysql:8.4",
		"CREATE DATABASE IF NOT EXISTS",
		"${set.databaseName}",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("LLMFleet RGD missing %q", want)
		}
	}
}

func TestLLMFleetGraphSeparatesNewAPIAdminAndTrafficPods(t *testing.T) {
	raw, err := os.ReadFile("30-llmfleet-rgd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"${schema.metadata.name + '-' + set.name + '-newapi-admin'}",
		"${schema.metadata.name + '-' + set.name + '-newapi-traffic'}",
		"${schema.metadata.name + '-' + set.name + '-newapi-admin-master'}",
		"${schema.metadata.name + '-' + set.name + '-newapi-traffic'}",
		"llmgateway.io/newapi-role: admin",
		"llmgateway.io/newapi-role: traffic",
		"llmgateway.io/newapi-serving: \"true\"",
		"- name: NODE_TYPE\n                      value: master",
		"- name: NODE_TYPE\n                      value: slave",
		"- name: SQL_MAX_OPEN_CONNS\n                      value: ${string(set.adminSQLMaxOpenConns)}",
		"- name: SQL_MAX_OPEN_CONNS\n                      value: ${string(set.trafficSQLMaxOpenConns)}",
		"- name: SQL_MAX_IDLE_CONNS\n                      value: ${string(set.adminSQLMaxIdleConns)}",
		"replicas: 1",
		"replicas: ${set.replicas}",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("LLMFleet RGD missing separated admin/traffic topology %q", want)
		}
	}
	if strings.Contains(content, "newapiAdminSlaveDeployments") || strings.Contains(content, "-newapi-admin-slave") {
		t.Fatal("LLMFleet RGD must not create a redundant admin slave deployment")
	}
}

func TestNewAPIProductionTemplatesDisableGlobalConsoleRateLimits(t *testing.T) {
	files := []string{
		"10-llmset-rgd.yaml",
		"30-llmfleet-rgd.yaml",
	}
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		content := string(raw)
		for _, want := range []string{
			"- name: GLOBAL_API_RATE_LIMIT_ENABLE\n                      value: \"false\"",
			"- name: GLOBAL_WEB_RATE_LIMIT_ENABLE\n                      value: \"false\"",
		} {
			if !strings.Contains(content, want) {
				t.Fatalf("%s missing %q", path, want)
			}
		}
	}
}

func TestSetManagerDoesNotOwnCapacityDecisions(t *testing.T) {
	raw, err := os.ReadFile("50-set-manager.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, forbidden := range []string{
		"LLMGATEWAY_SET_MANAGER_CAPACITY_ENABLED",
		"/api/admin/set-capacity/reconcile",
		"LLMGATEWAY_SET_MANAGER_REDIS_DB_LIMIT",
	} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("set-manager executor must not contain capacity behavior %q", forbidden)
		}
	}
}

func TestCapacityReconcilerExampleUsesRedisDBVariables(t *testing.T) {
	raw, err := os.ReadFile("examples/set-capacity-reconciler.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		"LLMGATEWAY_REDIS_DB_START",
		"LLMGATEWAY_REDIS_DB_LIMIT",
		`"redis_db_start": ${LLMGATEWAY_REDIS_DB_START}`,
		`"redis_db_limit": ${LLMGATEWAY_REDIS_DB_LIMIT}`,
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("capacity reconciler example missing %q", want)
		}
	}
}

func TestSetManagerUsesGoReconcilerWithoutCapacityDecisions(t *testing.T) {
	raw, err := os.ReadFile("50-set-manager.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{
		`command: ["/usr/local/bin/llmgateway-set-manager"]`,
		"LLMGATEWAY_SET_MANAGER_FLEET",
		"LLMGATEWAY_SET_MANAGER_SOURCE",
		"LLMGATEWAY_CONTROL_URL",
		"LLMGATEWAY_INTERNAL_TOKEN",
		"key: internal-token",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("set-manager manifest missing %q", want)
		}
	}
	if strings.Contains(content, "python") || strings.Contains(content, "def main():") {
		t.Fatalf("set-manager manifest must use the Go reconciler")
	}
	if strings.Contains(content, "reconcile_capacity") || strings.Contains(content, "/api/admin/set-capacity/reconcile") {
		t.Fatalf("set-manager executor must not perform capacity decisions")
	}
}

func decodeYAMLDocuments(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	decoder := yaml.NewDecoder(strings.NewReader(string(raw)))
	docs := []map[string]any{}
	for {
		var doc map[string]any
		err := decoder.Decode(&doc)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatal(err)
		}
		if len(doc) > 0 {
			docs = append(docs, doc)
		}
	}
	return docs
}
