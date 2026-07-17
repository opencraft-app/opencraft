package prodk8s

import (
	"io"
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestSetManagerOnlyOwnsLLMFleetCRD(t *testing.T) {
	raw := readFile(t, "llmgateway-set-manager.yaml.template")
	content := string(raw)
	for _, want := range []string{
		"kind: CronJob",
		`command: ["/usr/local/bin/llmgateway-set-manager"]`,
		"LLMGATEWAY_INTERNAL_TOKEN",
		"INTERNAL_SERVICE_TOKEN",
		`apiGroups: ["llmgateway.io"]`,
		`resources: ["llmfleets"]`,
		`verbs: ["get", "patch"]`,
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("set-manager manifest missing %q", want)
		}
	}
	for _, forbidden := range []string{
		`resources: ["secrets", "services"]`,
		`resources: ["deployments"]`,
		`apiGroups: ["batch"]`,
		`resources: ["jobs"]`,
		"LLMGATEWAY_SET_UPGRADE_PRECHECK_TIMEOUT_SECONDS",
		"LLMGATEWAY_SET_MANAGER_RUNTIME_BACKEND",
		"LLMGATEWAY_SET_MANAGER_NEWAPI_IMAGE",
		"cloud-load-newapi",
	} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("set-manager manifest must not contain %q", forbidden)
		}
	}
}

func TestAdminWriteWorkerIsIndependentlyScalable(t *testing.T) {
	content := string(readFile(t, "llmgateway-app.yaml.template"))
	for _, want := range []string{
		"name: llmgateway-worker-admin",
		"name: LLMGATEWAY_WORKER_POOL\n              value: admin",
		"name: LLMGATEWAY_ADMIN_WORKER_LEASE_TTL",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("production manifest missing admin command worker %q", want)
		}
	}
}

func TestLLMFleetRGDUsesKRO08CompatibleSchemaAndSecretRefs(t *testing.T) {
	raw := readFile(t, "llmfleet-rgd.yaml")
	content := string(raw)
	for _, want := range []string{
		"apiVersion: kro.run/v1alpha1",
		"kind: ResourceGraphDefinition",
		"name: llmfleets.llmgateway.io",
		"kind: LLMFleet",
		"sets: \"[]object\"",
		"shards: \"[]object\"",
		"cleanups: \"[]object\"",
		"secretKeyRef:",
		"mysqlAdminPassword",
		"mysqlAppPassword",
		"redisPasswordEncoded",
		"GLOBAL_API_RATE_LIMIT_ENABLE",
		"SEARCH_RATE_LIMIT_ENABLE",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("LLMFleet RGD missing %q", want)
		}
	}
	for _, forbidden := range []string{
		"scope: Namespaced",
		"mysqlAdminPassword: ${",
		"mysqlAppPassword: ${",
		"redisPassword: ${",
	} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("LLMFleet RGD must not contain %q", forbidden)
		}
	}
}

func TestLLMFleetRGDReclaimsSetRuntimeThroughBoundedCleanupJob(t *testing.T) {
	content := string(readFile(t, "llmfleet-rgd.yaml"))
	for _, want := range []string{
		"id: runtimeCleanupJobs",
		"cleanup.cleanupID",
		"name: ${cleanup.jobName}",
		"/usr/local/bin/llmgateway-runtime-cleaner",
		"automountServiceAccountToken: false",
		"restartPolicy: Never",
		"backoffLimit: 2",
		"activeDeadlineSeconds: 600",
		"LLMGATEWAY_CLEANUP_CAPABILITY",
		"redisDBStart",
		"redisDBLimit",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("LLMFleet RGD cleanup job missing %q", want)
		}
	}
	if strings.Contains(content, "name: ${cleanup.cleanupID + '-' + string(cleanup.attempt)}") {
		t.Fatal("LLMFleet RGD must not use the external cleanup id as a Kubernetes Job name")
	}
}

func TestLLMFleetRGDSeparatesNewAPIAdminAndTrafficPods(t *testing.T) {
	raw := readFile(t, "llmfleet-rgd.yaml")
	content := string(raw)
	for _, want := range []string{
		"${schema.metadata.name + '-' + set.name + '-newapi-admin'}",
		"${schema.metadata.name + '-' + set.name + '-newapi-traffic'}",
		"${schema.metadata.name + '-' + set.name + '-newapi-admin-master'}",
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

func TestLLMFleetRGDConfiguresTCRPullSecretForEveryManagedPod(t *testing.T) {
	content := string(readFile(t, "llmfleet-rgd.yaml"))
	const pullSecret = "imagePullSecrets:\n                - name: tcr-pull-secret"
	if count := strings.Count(content, pullSecret); count != 4 {
		t.Fatalf("TCR pull secret occurrences = %d, want admin, legacy traffic, runtime traffic and cleanup job", count)
	}
}

func TestLLMFleetAdminServiceRoutesControlWritesToMasterOnly(t *testing.T) {
	raw := readFile(t, "llmfleet-rgd.yaml")
	content := string(raw)
	start := strings.Index(content, "    - id: newapiAdminServices")
	end := strings.Index(content, "    - id: newapiTrafficServices")
	if start < 0 || end <= start {
		t.Fatal("LLMFleet RGD admin Service resource block not found")
	}
	adminService := content[start:end]
	want := "app.kubernetes.io/name: ${schema.metadata.name + '-' + set.name + '-newapi-admin-master'}"
	if !strings.Contains(adminService, want) {
		t.Fatalf("LLMFleet admin Service must route control writes to master only; missing %q", want)
	}
	if strings.Contains(adminService, "llmgateway.io/newapi-role: admin\n          ports:") {
		t.Fatal("LLMFleet admin Service must not load-balance control writes across admin master and slave")
	}
}

func TestLLMFleetTrafficServiceRoutesOnlyToSlavePods(t *testing.T) {
	raw := readFile(t, "llmfleet-rgd.yaml")
	content := string(raw)
	start := strings.Index(content, "    - id: newapiTrafficServices")
	end := strings.Index(content, "    - id: newapiAdminMasterDeployments")
	if start < 0 || end <= start {
		t.Fatal("LLMFleet RGD traffic Service resource block not found")
	}
	trafficService := content[start:end]
	if !strings.Contains(trafficService, "llmgateway.io/newapi-role: traffic") {
		t.Fatal("traffic Service must select only NODE_TYPE=slave traffic pods")
	}
	if strings.Contains(trafficService, "llmgateway.io/newapi-serving") {
		t.Fatal("traffic Service must not select the admin master")
	}
}

func TestLLMFleetBootstrapKeepsSecretsOutOfSpec(t *testing.T) {
	raw := readFile(t, "llmfleet.yaml.template")
	content := string(raw)
	for _, want := range []string{
		"kind: LLMFleet",
		"secretName: llmfleet-shard-a",
		"secretName: llmfleet-shard-b",
		"sets: []",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("LLMFleet template missing %q", want)
		}
	}
	for _, forbidden := range []string{
		"name: set-a",
		"name: set-b",
		"newapi_set_a",
		"newapi_set_b",
		"mysqlAdminPassword",
		"mysqlAppPassword",
		"redisPassword",
		"SHARD_A_MYSQL_ROOT_PASSWORD",
		"NEWAPI_APP_MYSQL_PASSWORD",
	} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("LLMFleet template must not contain %q", forbidden)
		}
	}
}

func TestProductionDocsLockKROVersionAndBootstrapWarning(t *testing.T) {
	raw := readFile(t, "README.md")
	content := string(raw)
	for _, want := range []string{
		"--version 0.8.5",
		"v0.8.5-amd64",
		"field label not supported: spec.snapshot.name",
		"bootstrap 模板",
		"不是持续覆盖模板",
		"spec.sets",
		"只 patch `spec.shards`",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("production README missing %q", want)
		}
	}
}

func TestShardPatchDoesNotOverwriteFleetSets(t *testing.T) {
	patchTemplate := string(readFile(t, "llmfleet-shards-patch.json.template"))
	for _, want := range []string{
		`"spec"`,
		`"shards"`,
		`"secretName": "llmfleet-shard-a"`,
		`"secretName": "llmfleet-shard-b"`,
	} {
		if !strings.Contains(patchTemplate, want) {
			t.Fatalf("shard patch template missing %q", want)
		}
	}
	if strings.Contains(patchTemplate, `"sets"`) {
		t.Fatalf("shard patch template must not include spec.sets")
	}

	script := string(readFile(t, "patch-llmfleet-shards.sh"))
	for _, want := range []string{
		"SCRIPT_DIR=",
		"llmfleet-shards-patch.json.template",
		"patch llmfleet",
		"--type=merge",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("shard patch script missing %q", want)
		}
	}
}

func TestTrafficServiceTemplateExposesHTTPSWithTencentCertificateSecret(t *testing.T) {
	raw := readFile(t, "llmgateway-app.yaml.template")
	content := string(raw)
	for _, want := range []string{
		"kind: Secret",
		"name: ${TRAFFIC_CERT_SECRET}",
		"qcloud_cert_id: ${TRAFFIC_CERT_ID}",
		`"443":{"protocol":["HTTPS"]`,
		`"${TRAFFIC_HOST}":{"tls":"${TRAFFIC_CERT_SECRET}"}`,
		"name: https",
		"port: 443",
		"targetPort: http",
		"LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS",
		"LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS_PER_HOST",
		"LLMGATEWAY_UPSTREAM_IDLE_CONN_TIMEOUT",
		"LLMGATEWAY_DRAIN_WAIT",
		"LLMGATEWAY_SHUTDOWN_TIMEOUT",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("traffic template missing %q", want)
		}
	}
}

func TestProductionAppsUseProcessScopedRuntimeSecrets(t *testing.T) {
	raw := readFile(t, "llmgateway-app.yaml.template")
	content := string(raw)
	for _, want := range []string{
		"name: llmgateway-control-runtime",
		"name: llmgateway-traffic-runtime",
		"name: llmgateway-worker-runtime",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("app template missing process-scoped runtime secret %q", want)
		}
	}
	if strings.Contains(content, "name: llmgateway-runtime") {
		t.Fatalf("app template must not use shared llmgateway-runtime secret")
	}
}

func TestControlAllowsOnlineSchemaMigrationDuringStartup(t *testing.T) {
	raw := readFile(t, "llmgateway-app.yaml.template")
	docs := decodeYAMLDocuments(t, raw)
	control := deploymentContainer(t, docs, "llmgateway-control", "control")
	requireEnv(t, control, "LLMGATEWAY_SQL_STARTUP_TIMEOUT", "10m")
	requireEnv(t, control, "LLMGATEWAY_TRAFFIC_BASE_URL", "http://llmgateway-traffic")
	requireEnv(t, control, "LLMGATEWAY_TRAFFIC_PROBE_TIMEOUT", "120s")

	probe, _ := control["startupProbe"].(map[string]any)
	httpGet, _ := probe["httpGet"].(map[string]any)
	if httpGet["path"] != "/healthz" || httpGet["port"] != "http" {
		t.Fatalf("control startup probe = %+v", probe)
	}
	if probe["periodSeconds"] != 5 || probe["failureThreshold"] != 120 {
		t.Fatalf("control startup probe window = %+v, want 10 minutes", probe)
	}
}

func TestProductionEnablesStdoutTracingForControlAndWorkerOnly(t *testing.T) {
	raw := readFile(t, "llmgateway-app.yaml.template")
	docs := decodeYAMLDocuments(t, raw)

	control := deploymentContainer(t, docs, "llmgateway-control", "control")
	requireEnv(t, control, "LLMGATEWAY_OTEL_STDOUT_ENABLE", "true")
	requireEnv(t, control, "OTEL_SERVICE_NAME", "llmgateway-control")
	requireEnv(t, control, "LLMGATEWAY_ENVIRONMENT", "prod")

	for _, item := range []struct {
		deployment string
		pool       string
	}{
		{deployment: "llmgateway-worker-core", pool: "core"},
		{deployment: "llmgateway-worker-byok", pool: "byok"},
		{deployment: "llmgateway-worker-observer", pool: "observer"},
		{deployment: "llmgateway-worker-maintenance", pool: "maintenance"},
	} {
		worker := deploymentContainer(t, docs, item.deployment, "worker")
		requireEnv(t, worker, "LLMGATEWAY_WORKER_POOL", item.pool)
		requireEnv(t, worker, "LLMGATEWAY_OTEL_STDOUT_ENABLE", "true")
		requireEnv(t, worker, "OTEL_SERVICE_NAME", item.deployment)
		requireEnv(t, worker, "LLMGATEWAY_ENVIRONMENT", "prod")
		requireEnv(t, worker, "LLMGATEWAY_SQL_MAX_OPEN_CONNS", map[string]string{"core": "12", "byok": "16", "observer": "16", "maintenance": "12"}[item.pool])
	}

	traffic := deploymentContainer(t, docs, "llmgateway-traffic", "traffic")
	if _, ok := envValue(traffic, "LLMGATEWAY_OTEL_STDOUT_ENABLE"); ok {
		t.Fatalf("traffic should not enable stdout tracing by default")
	}
}

func TestProductionOTelIncludesVersionAndKubernetesResourceIdentity(t *testing.T) {
	app := string(readFile(t, "llmgateway-app.yaml.template"))
	for _, want := range []string{
		"OTEL_SERVICE_VERSION", "${LLMGATEWAY_VERSION}",
		"name: K8S_NAMESPACE_NAME", "fieldPath: metadata.namespace",
		"name: K8S_POD_NAME", "fieldPath: metadata.name",
		"name: K8S_POD_UID", "fieldPath: metadata.uid",
		"name: CLOUD_REGION", "${CLOUD_REGION}",
	} {
		if !strings.Contains(app, want) {
			t.Fatalf("application telemetry manifest missing %q", want)
		}
	}
	setManager := string(readFile(t, "llmgateway-set-manager.yaml.template"))
	for _, want := range []string{"LLMGATEWAY_OTEL_STDOUT_ENABLE", "llmgateway-set-manager", "OTEL_SERVICE_VERSION", "K8S_POD_UID"} {
		if !strings.Contains(setManager, want) {
			t.Fatalf("set-manager telemetry manifest missing %q", want)
		}
	}
	rgd := string(readFile(t, "llmfleet-rgd.yaml"))
	for _, want := range []string{"llmgateway-runtime-cleaner", "LLMGATEWAY_OTEL_STDOUT_ENABLE", "OTEL_SERVICE_VERSION", "K8S_POD_UID"} {
		if !strings.Contains(rgd, want) {
			t.Fatalf("runtime-cleaner telemetry manifest missing %q", want)
		}
	}
}

func TestSetManagerUsesScopedRuntimeSecret(t *testing.T) {
	raw := readFile(t, "llmgateway-set-manager.yaml.template")
	content := string(raw)
	for _, want := range []string{
		"name: llmgateway-set-manager-runtime",
		"key: INTERNAL_SERVICE_TOKEN",
		"LLMGATEWAY_SET_MANAGER_SOURCE",
		"LLMGATEWAY_SET_MANAGER_FLEET",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("set-manager template missing %q", want)
		}
	}
	if strings.Contains(content, "name: llmgateway-runtime") {
		t.Fatalf("set-manager template must not use shared llmgateway-runtime secret")
	}
	for _, forbidden := range []string{
		"envFrom:",
		"CLUSTER_ADMIN_TOKEN",
		"name: llmgateway-control-runtime",
		"LLMGATEWAY_SET_MANAGER_CAPACITY_ENABLED",
		"LLMGATEWAY_SET_MANAGER_MAX_USERS_PER_SET",
		"LLMGATEWAY_SET_MANAGER_TARGET_UTILIZATION",
		"LLMGATEWAY_SET_MANAGER_MIN_READY_FREE_USERS",
		"LLMGATEWAY_SET_MANAGER_MIN_WARM_SETS",
		"LLMGATEWAY_SET_MANAGER_MAX_SCALE_UP_PER_CYCLE",
		"LLMGATEWAY_SET_MANAGER_SET_ID_PREFIX",
		"LLMGATEWAY_SET_MANAGER_SHARD_REFS",
		"LLMGATEWAY_SET_MANAGER_REDIS_DB_START",
		"LLMGATEWAY_SET_MANAGER_REDIS_DB_LIMIT",
	} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("set-manager executor must not expose capacity setting %q", forbidden)
		}
	}
}

func TestProductionWorkerBootstrapsWarmSetsThroughCapacityJob(t *testing.T) {
	raw := readFile(t, "llmgateway-app.yaml.template")
	content := string(raw)
	for _, want := range []string{
		"command: [\"/usr/local/bin/llmgateway-worker\"]",
		"LLMGATEWAY_SET_AUTOSCALER_ENABLED",
		"LLMGATEWAY_SET_AUTOSCALER_SOURCE",
		"LLMGATEWAY_SET_AUTOSCALER_NAMESPACE",
		"LLMGATEWAY_SET_AUTOSCALER_FLEET",
		"LLMGATEWAY_SET_AUTOSCALER_MIN_WARM_SETS",
		"value: \"2\"",
		"LLMGATEWAY_SET_AUTOSCALER_MAX_SCALE_UP_PER_CYCLE",
		"LLMGATEWAY_SET_AUTOSCALER_SHARD_REFS",
		"value: shard-a,shard-b",
		"LLMGATEWAY_WORKER_POLL_INTERVAL",
		"LLMGATEWAY_WORKER_LEASE_TTL",
		"LLMGATEWAY_WORKER_CHANNEL_DRIFT_BATCH_SIZE",
		"LLMGATEWAY_WORKER_CHANNEL_DRIFT_ITEM_TIMEOUT",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("worker template missing warm set bootstrap config %q", want)
		}
	}
	for _, oldName := range []string{
		"LLMGATEWAY_SET_CAPACITY_ENABLED",
		"LLMGATEWAY_SET_MANAGER_MAX_USERS_PER_SET",
		"LLMGATEWAY_SET_MANAGER_TARGET_UTILIZATION",
		"LLMGATEWAY_SET_MANAGER_MIN_READY_FREE_USERS",
		"LLMGATEWAY_SET_MANAGER_MIN_WARM_SETS",
		"LLMGATEWAY_SET_MANAGER_MAX_SCALE_UP_PER_CYCLE",
		"LLMGATEWAY_SET_MANAGER_SET_ID_PREFIX",
		"LLMGATEWAY_SET_MANAGER_SHARD_REFS",
		"LLMGATEWAY_SET_MANAGER_REDIS_DB_START",
		"LLMGATEWAY_SET_MANAGER_REDIS_DB_LIMIT",
	} {
		if strings.Contains(content, oldName) {
			t.Fatalf("worker template still contains legacy autoscaler config %q", oldName)
		}
	}
}

func TestProductionTrafficSmokeReusesOpenSourceGoMockLLM(t *testing.T) {
	script := string(readFile(t, "smoke/run-traffic-smoke.sh"))
	for _, want := range []string{
		"k8s/orbstack-kro/e2e",
		"00-mock-openai.yaml",
		"10-traffic-e2e-job.yaml",
		"llmgateway-control-runtime",
		"CLUSTER_ADMIN_TOKEN",
		"/dev/termination-log",
		"kubectl wait --for=condition=complete",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("prod smoke script missing %q", want)
		}
	}

	mock := string(readFile(t, "../../../k8s/orbstack-kro/e2e/00-mock-openai.yaml"))
	if !strings.Contains(mock, "github.com/kagent-dev/mockllm/cmd/mockllm") {
		t.Fatalf("prod smoke must keep using the shared open source Go mockllm manifest")
	}

	runner := string(readFile(t, "../../../k8s/orbstack-kro/e2e/10-traffic-e2e-job.yaml"))
	for _, want := range []string{
		"func chatWithControlPlanePropagationRetry",
		"model_price_error",
		"model_not_found",
		"channel and pricing propagation did not reach traffic runtime",
	} {
		if !strings.Contains(runner, want) {
			t.Fatalf("prod smoke runner missing pricing propagation guard %q", want)
		}
	}
}

func TestCloudMockLLMFixtureSupportsUpgradeProbeAndUserTraffic(t *testing.T) {
	mock := string(readFile(t, "smoke/cloud-mockllm.yaml"))
	for _, want := range []string{
		"kind: ConfigMap",
		"name: cloud-mockllm",
		`"content": "reply with ok"`,
		`"content": "你好"`,
		"mountPath: /etc/mockllm/config.json",
		"subPath: config.json",
		"lightclaw-bj82.tencentcloudcr.com/llmgateway/llmgateway:mockllm-go-225524",
	} {
		if !strings.Contains(mock, want) {
			t.Fatalf("cloud mockllm fixture missing %q", want)
		}
	}
}

func TestRuntimeSecretMigrationScopesTrafficSecret(t *testing.T) {
	script := string(readFile(t, "migrate-runtime-secrets.sh"))
	for _, want := range []string{
		"llmgateway-runtime",
		"llmgateway-control-runtime",
		"llmgateway-worker-runtime",
		"llmgateway-traffic-runtime",
		"LLMGATEWAY_KEY_ROUTE_CACHE_",
		"create secret generic",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("runtime secret migration script missing %q", want)
		}
	}
}

func TestControlPublicServiceTemplateUsesIndependentHTTPSHost(t *testing.T) {
	raw := readFile(t, "llmgateway-app.yaml.template")
	content := string(raw)
	for _, want := range []string{
		"name: ${CONTROL_CERT_SECRET}",
		"qcloud_cert_id: ${CONTROL_CERT_ID}",
		"name: llmgateway-control-public",
		`"443":{"protocol":["HTTPS"]`,
		`"${CONTROL_HOST}":{"tls":"${CONTROL_CERT_SECRET}"}`,
		"selector:\n    app: llmgateway-control",
		"name: https",
		"port: 443",
		"targetPort: http",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("control public template missing %q", want)
		}
	}
}

func TestProductionYAMLDocumentsParse(t *testing.T) {
	for _, path := range []string{
		"llmfleet-rgd.yaml",
		"llmfleet-shard-secrets.yaml.template",
		"llmfleet.yaml.template",
		"llmgateway-set-manager.yaml.template",
	} {
		decodeYAMLDocuments(t, readFile(t, path))
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func decodeYAMLDocuments(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	decoder := yaml.NewDecoder(strings.NewReader(string(raw)))
	docs := []map[string]any{}
	for {
		var doc map[string]any
		err := decoder.Decode(&doc)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(doc) > 0 {
			docs = append(docs, doc)
		}
	}
	if len(docs) == 0 {
		t.Fatalf("expected at least one YAML document")
	}
	return docs
}

func deploymentContainer(t *testing.T, docs []map[string]any, deploymentName, containerName string) map[string]any {
	t.Helper()
	for _, doc := range docs {
		if doc["kind"] != "Deployment" {
			continue
		}
		metadata, _ := doc["metadata"].(map[string]any)
		if metadata["name"] != deploymentName {
			continue
		}
		spec, _ := doc["spec"].(map[string]any)
		template, _ := spec["template"].(map[string]any)
		templateSpec, _ := template["spec"].(map[string]any)
		containers, _ := templateSpec["containers"].([]any)
		for _, rawContainer := range containers {
			container, _ := rawContainer.(map[string]any)
			if container["name"] == containerName {
				return container
			}
		}
	}
	t.Fatalf("deployment %s container %s not found", deploymentName, containerName)
	return nil
}

func requireEnv(t *testing.T, container map[string]any, name, want string) {
	t.Helper()
	got, ok := envValue(container, name)
	if !ok {
		t.Fatalf("container missing env %s", name)
	}
	if got != want {
		t.Fatalf("env %s = %q, want %q", name, got, want)
	}
}

func envValue(container map[string]any, name string) (string, bool) {
	env, _ := container["env"].([]any)
	for _, rawEnv := range env {
		entry, _ := rawEnv.(map[string]any)
		if entry["name"] == name {
			value, _ := entry["value"].(string)
			return value, true
		}
	}
	return "", false
}
